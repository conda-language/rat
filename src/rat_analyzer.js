// The semantic analyzer exports a single function, analyze(match), that
// accepts a grammar match object (the CST) from Ohm and produces the
// internal representation of the program (pretty close to what is usually
// called the AST). This representation also includes entities from the
// standard library, as needed.
import * as core from "./core.js"


const INT = core.Type.INT
const FLOAT = core.Type.FLOAT
const STRING = core.Type.STRING
const BOOLEAN = core.Type.BOOLEAN
const ANY = core.Type.ANY
const VOID = core.Type.VOID

function must(condition, message, errorLocation) {
  if (!condition) {
    const prefix = errorLocation.at.source.getLineAndColumnMessage()
    throw new Error(`${prefix}${message}`)
  }
}

class Context {
  constructor({ parent, locals = {} }) {
    this.parent = parent
    this.locals = new Map(Object.entries(locals))
    this.withinLoop = false
    this.function = null
  }
  add(name, entity) {
    this.locals.set(name, entity)
  }
  lookup(name) {
    return this.locals.get(name) || this.parent?.lookup(name)
  }
  newChildContext(props) {
    return new Context({ ...this, ...props, parent: this, locals: new Map() })
  }
  get(name, expectedType, node) {
    let entity
    for (let context = this; context; context = context.parent) {
      entity = context.locals.get(name)
      if (entity) break
    }
    must(entity, `${name} has not been declared`, node)
    must(
      entity.constructor === expectedType,
      `${name} was expected to be a ${expectedType.name}`,
      node
    )
    return entity
  }
}


function mustHaveNumericType(e, at) {
  must([INT, FLOAT].includes(e.type), "Expected a number", at)
}
function mustHaveNumericOrStringType(e, at) {
  must([INT, FLOAT, STRING].includes(e.type), "Expected a number or string", at)
}
function mustHaveBooleanType(e, at) {
  must(e.type === BOOLEAN, "Expected a boolean", at)
}
function mustHaveIntegerType(e, at) {
  must(e.type === INT, "Expected an integer", at)
}
function mustBeTheSameType(e1, e2, at) {
  must(equivalent(e1.type, e2.type), "Operands do not have the same type", at)
}
function equivalent(t1, t2) {
  return (
    t1 === t2 ||
    (t1 instanceof core.OptionalType &&
      t2 instanceof core.OptionalType &&
      equivalent(t1.baseType, t2.baseType)) ||
    (t1 instanceof core.ArrayType &&
      t2 instanceof core.ArrayType &&
      equivalent(t1.baseType, t2.baseType)) ||
    (t1.constructor === core.FunctionType &&
      t2.constructor === core.FunctionType &&
      equivalent(t1.returnType, t2.returnType) &&
      t1.paramTypes.length === t2.paramTypes.length &&
      t1.paramTypes.every((t, i) => equivalent(t, t2.paramTypes[i])))
  )
}

function mustNotBeReadOnly(e, at) {
  check(!e.readOnly, `Cannot assign to constant ${e.name}`, at)
}
function mustBeInLoop(context, at) {
  check(context.inLoop, "Break can only appear in a loop", at)
}

function mustNotAlreadyBeDeclared(context, name, at) {
  check(!context.lookup(name), `Identifier ${name} already declared`, at)
}
function mustBeInAFunction(context, at) {
  check(context.function, "Return can only appear in a function", at)
}


export default function analyze(match) {
  // Track the context manually via a simple variable. The initial context
  // contains the mappings from the standard library. Add to this context
  // as necessary. When needing to descent into a new scope, create a new
  // context with the current context as its parent. When leaving a scope,
  // reset this variable to the parent context.
  let context = new Context({ locals: core.standardLibrary })

  // The single gate for error checking. Pass in a condition that must be true.
  // Use errorLocation to give contextual information about the error that will
  // appear: this should be an object whose "at" property is a parse tree node.
  // Ohm's getLineAndColumnMessage will be used to prefix the error message.
  function must(condition, message, errorLocation) {
    if (!condition) {
      const prefix = errorLocation.at.source.getLineAndColumnMessage()
      throw new Error(`${prefix}${message}`)
    }
  }

  function mustNotAlreadyBeDeclared(name, at) {
    must(!context.locals.has(name), `Identifier ${name} already declared`, at)
  }

  function mustHaveBeenFound(entity, name, at) {
    must(entity, `Identifier ${name} not declared`, at)
  }

  function mustBeAVariable(entity, at) {
    // Bella has two kinds of entities: variables and functions.
    must(entity?.kind === "Variable", `Functions can not appear here`, at)
  }

  function mustBeAFunction(entity, at) {
    must(entity?.kind === "Function", `${entity.name} is not a function`, at)
  }

  function mustNotBeReadOnly(entity, at) {
    must(!entity.readOnly, `${entity.name} is read only`, at)
  }

  function mustHaveCorrectArgumentCount(argCount, paramCount, at) {
    const equalCount = argCount === paramCount
    must(equalCount, `${paramCount} argument(s) required but ${argCount} passed`, at)
  }

  const builder = match.matcher.grammar.createSemantics().addOperation("rep", {
    Program(statements) {
      return core.program(statements.children.map(s => s.rep()))
    },

    Stmt_print(_print, _lparen, exp, _rparen, _semicolon) {
      return core.printStatement(exp.rep())
    },

    Stmt_vardec(_var, id, _colon, type, _eq, exp, _semicolon){
      // TODO: Need to do something else with the 'type'
      const initializer = exp.rep()
      const variable = core.variable(id.sourceString, false)
      mustNotAlreadyBeDeclared(id.sourceString, {at:id})
      // TODO: Add type checking
      // exp must be of type 'type'
      context.add(id.sourceString, variable)

      return core.variableDeclaration(variable, initializer)
    },

    FuncDecl(type, id, params, exp, _semicolon) {
      params = params.asIteration().children
      const fun = new core.Function(id.sourceString, params.length, true)
      // Add the function to the context before analyzing the body, because
      // we want to allow functions to be recursive
      context.add(id.sourceString, fun, id)
      context = new Context(context)
      context.function = fun
      const paramsRep = params.map((p) => {
        let variable = new core.Variable(p.sourceString, true)
        context.add(p.sourceString, variable, p)
        return variable
      })
      const bodyRep = body.rep()
      context = context.parent
      return new core.FunctionDeclaration(fun, paramsRep, bodyRep)
    },

    Params(_open, idList, _close) {
      return idList.asIteration().children.map(id => {
        const param = core.variable(id.sourceString, true)
        // All of the parameters have to be unique
        mustNotAlreadyBeDeclared(id.sourceString, { at: id })
        context.add(id.sourceString, param)
        return param
      })
    },

    Statement_assign(id, _eq, exp, _semicolon) {
      const target = id.rep()
      mustNotBeReadOnly(target, { at: id })
      return core.assignment(target, exp.rep())
    },

    

    Statement_while(_while, exp, block) {
      return core.whileStatement(exp.rep(), block.rep())
    },

    Block(_open, statements, _close) {
      return statements.children.map(s => s.rep())
    },

    Exp_unary(op, exp) {
      return core.unary(op.sourceString, exp.rep())
    },

    Exp_ternary(exp1, _questionMark, exp2, _colon, exp3) {
      return core.conditional(exp1.rep(), exp2.rep(), exp3.rep())
    },

    Exp1_binary(exp1, op, exp2) {
      return core.binary(op.sourceString, exp1.rep(), exp2.rep())
    },

    Exp2_binary(exp1, op, exp2) {
      return core.binary(op.sourceString, exp1.rep(), exp2.rep())
    },

    Exp3_binary(exp1, op, exp2) {
      return core.binary(op.sourceString, exp1.rep(), exp2.rep())
    },

    Exp4_binary(exp1, op, exp2) {
      return core.binary(op.sourceString, exp1.rep(), exp2.rep())
    },

    Exp5_binary(exp1, op, exp2) {
      return core.binary(op.sourceString, exp1.rep(), exp2.rep())
    },

    Exp6_binary(exp1, op, exp2) {
      return core.binary(op.sourceString, exp1.rep(), exp2.rep())
    },

    Exp7_parens(_open, exp, _close) {
      return exp.rep()
    },

    Exp7_call(id, _open, expList, _close) {
      // ids used in calls must have already been declared and must be
      // bound to function entities, not to variable entities.
      const callee = context.lookup(id.sourceString)
      mustHaveBeenFound(callee, id.sourceString, { at: id })
      mustBeAFunction(callee, { at: id })
      const args = expList.asIteration().children.map(arg => arg.rep())
      mustHaveCorrectArgumentCount(args.length, callee.paramCount, { at: id })
      return core.call(callee, args)
    },

    Exp7_id(id) {
      // ids used in expressions must have been already declared and must
      // be bound to variable entities, not function entities.
      const entity = context.lookup(id.sourceString)
      mustHaveBeenFound(entity, id.sourceString, { at: id })
      mustBeAVariable(entity, { at: id })
      return entity
    },

    true(_) {
      return true
    },

    false(_) {
      return false
    },

    num(_whole, _point, _fraction, _e, _sign, _exponent) {
      return Number(this.sourceString)
    },
    
    str(_open, chars, _close) {
      return chars.sourceString
    }
  })
  return builder(match).rep()
}