// The semantic analyzer exports a single function, analyze(match), that
// accepts a grammar match object (the CST) from Ohm and produces the
// internal representation of the program (pretty close to what is usually
// called the AST). This representation also includes entities from the
// standard library, as needed.
import * as core from "./core.js";
import util from "util";

const INT = core.intType;
const FLOAT = core.floatType;
const STRING = core.stringType;
const BOOLEAN = core.boolType;
const ANY = core.anyType;
const VOID = core.voidType;

const types = {
  int: INT,
  float: FLOAT,
  str: STRING,
  bool: BOOLEAN,
  void: VOID,
  any: ANY,
  None: VOID,
};

class Context {
  constructor({ parent, locals = {} }) {
    this.parent = parent;
    this.locals = new Map(Object.entries(locals));
    this.withinLoop = false;
    this.function = null;
  }
  add(name, entity) {
    this.locals.set(name, entity);
  }

  lookup(name) {
    return this.locals.get(name) || this.parent?.lookup(name);
  }

  static root() {
    return new Context({
      locals: new Map(Object.entries(core.standardLibrary)),
    });
  }

  newChildContext(props) {
    return new Context({ ...this, ...props, parent: this, locals: new Map() });
  }
}

export default function analyze(match) {
  // Track the context manually via a simple variable. The initial context
  // contains the mappings from the standard library. Add to this context
  // as necessary. When needing to descent into a new scope, create a new
  // context with the current context as its parent. When leaving a scope,
  // reset this variable to the parent context.
  let context = Context.root();

  // The single gate for error checking. Pass in a condition that must be true.
  // Use errorLocation to give contextual information about the error that will
  // appear: this should be an object whose "at" property is a parse tree node.
  // Ohm's getLineAndColumnMessage will be used to prefix the error message.
  function must(condition, message, errorLocation) {
    if (!condition) {
      const prefix = errorLocation.at.source.getLineAndColumnMessage();
      throw new Error(`${prefix}${message}`);
    }
  }

  function mustNotAlreadyBeDeclared(name, at) {
    must(!context.locals.has(name), `Identifier ${name} already declared`, at);
  }

  function mustHaveBeenFound(entity, name, at) {
    must(entity, `Identifier ${name} not declared`, at);
  }

  function mustHaveNumericType(e, at) {
    must([INT, FLOAT].includes(e.type), "Expected a number", at);
  }

  function mustHaveNumericOrStringType(e, at) {
    must(
      [INT, FLOAT, STRING].includes(e.type),
      "Expected a number or string",
      at
    );
  }

  function mustHaveBooleanType(e, at) {
    must(e.type === BOOLEAN, "Expected a boolean", at);
  }

  function mustHaveIntegerType(e, at) {
    must(e.type === INT, "Expected an integer", at);
  }

  function mustHaveArrayType(e, at) {
    must(e.type?.kind === "ArrayType", "Expected an array", at);
  }

  function mustHaveAnOptionalType(e, at) {
    must(e.type?.kind === "OptionalType", "Expected an optional", at);
  }

  function mustBothHaveTheSameType(e1, e2, at) {
    must(
      equivalent(e1.type, e2.type),
      "Operands do not have the same type",
      at
    );
  }

  function mustAllHaveSameType(expressions, at) {
    // Used to check the elements of an array expression, and the two
    // arms of a conditional expression, among other scenarios.
    must(
      expressions
        .slice(1)
        .every((e) => equivalent(e.type, expressions[0].type)),
      "Not all elements have the same type",
      at
    );
  }

  function mustBeAType(e, at) {
    // This is a rather ugly hack
    must(e?.kind.endsWith("Type"), "Type expected", at);
  }

  function mustBeAnArrayType(t, at) {
    must(t?.kind === "ArrayType", "Must be an array type", at);
  }

  // ↓ ↓ NOT IN TOALS CODE ↓ ↓
  function mustHaveIterableType(e, at) {
    must(
      (e.type?.kind === "ArrayType") |
        (e.type?.kind === "DictType") |
        (e.type?.kind === STRING),
      `${e.type?.kind} is not an iterable object`,
      at
    );
  }

  function mustBeTheSameType(e1, e2, at) {
    must(
      equivalent(e1.type, e2.type),
      "Operands do not have the same type",
      at
    );
  }

  // function equivalent(t1, t2) {
  //   return (
  //     t1 === t2 ||
  //     (t1 instanceof core.OptionalType &&
  //       t2 instanceof core.OptionalType &&
  //       equivalent(t1.baseType, t2.baseType)) ||
  //     (t1 instanceof core.ArrayType &&
  //       t2 instanceof core.ArrayType &&
  //       equivalent(t1.baseType, t2.baseType)) ||
  //     (t1.constructor === core.FunctionType && t2.constructor === core.FunctionType &&
  //       equivalent(t1.returnType, t2.returnType) &&
  //       t1.paramTypes.length === t2.paramTypes.length &&
  //       t1.paramTypes.every((t, i) => equivalent(t, t2.paramTypes[i])))
  //   );
  // }

  function equivalent(t1, t2) {
    return (
      t1 === t2 ||
      (t1?.kind === "OptionalType" &&
        t2?.kind === "OptionalType" &&
        equivalent(t1.baseType, t2.baseType)) ||
      (t1?.kind === "ArrayType" &&
        t2?.kind === "ArrayType" &&
        equivalent(t1.baseType, t2.baseType)) ||
      (t1?.kind === "FunctionType" &&
        t2?.kind === "FunctionType" &&
        equivalent(t1.returnType, t2.returnType) &&
        t1.paramTypes.length === t2.paramTypes.length &&
        t1.paramTypes.every((t, i) => equivalent(t, t2.paramTypes[i])))
    );
  }

  function assignable(fromType, toType) {
    return (
      toType == ANY ||
      equivalent(fromType, toType) ||
      (fromType?.kind === "FunctionType" &&
        toType?.kind === "FunctionType" &&
        // covariant in return types
        assignable(fromType.returnType, toType.returnType) &&
        fromType.paramTypes.length === toType.paramTypes.length &&
        // contravariant in parameter types
        toType.paramTypes.every((t, i) =>
          assignable(t, fromType.paramTypes[i])
        ))
    );
  }

  function typeDescription(type) {
    // TODO: add cases for promise type, dictionary type, and noneType (variant of void type)
    switch (type.kind) {
      case "IntType":
        return "int";
      case "FloatType":
        return "float";
      case "StringType":
        return "str";
      case "BoolType":
        return "bool";
      case "VoidType":
        return "void";
      case "AnyType":
        return "any";
      case "FunctionType":
        const paramTypes = type.paramTypes.map(typeDescription).join(", ");
        const returnType = typeDescription(type.returnType);
        return `(${paramTypes})->${returnType}`;
      case "ArrayType":
        return `[${typeDescription(type.baseType)}]`;
      case "OptionalType":
        return `${typeDescription(type.baseType)}?`;
    }
  }

  function primitiveTypeMapper(type) {
    // CHECK WITH TA
    if (type.charAt(type.length - 1) === "?") {
      return core.optionalType(primitiveTypeMapper(type.slice(0, -1)));
    }
    if (type.charAt(0) === "[" && type.charAt(type.length - 1) === "]") {
      return core.arrayType(primitiveTypeMapper(type.slice(1, -1)));
    }
    switch (type) {
      case "int":
        return INT;
      case "float":
        return FLOAT;
      case "str":
        return STRING;
      case "bool":
        return BOOLEAN;
      case "void":
        return VOID;
      case "any":
        return ANY;
    }
  }

  function mustBeAssignable(e, { toType: type }, at) {
    const message = `Cannot assign a ${typeDescription(
      e.type
    )} to a ${typeDescription(type)}`;
    must(assignable(e.type, type), message, at);
  }

  function mustNotBeReadOnly(entity, at) {
    must(!entity.readOnly, `${entity.name} is read only`, at);
  }

  function mustBeInLoop(context, at) {
    must(context.withinLoop, "Break statement must be inside a loop", at);
  }

  function mustBeInAFunction(at) {
    must(context.function, "Return can only appear in a function", at);
  }

  function mustBeCallable(e, at) {
    const callable =
      e?.kind === "StructType" || e.type?.kind === "FunctionType";
    must(callable, "Call of non-function or non-constructor", at);
  }

  function mustNotReturnAnything(f, at) {
    must(f.type.returnType === VOID, "Something should be returned", at);
  }

  function mustReturnSomething(f, at) {
    must(
      f.type.returnType !== VOID,
      "Cannot return a value from this function",
      at
    );
  }

  function mustBeReturnable(e, { from: f }, at) {
    mustBeAssignable(e, { toType: f.type.returnType }, at);
  }

  function mustHaveCorrectArgumentCount(argCount, paramCount, at) {
    const message = `${paramCount} argument(s) required but ${argCount} passed`;
    must(argCount === paramCount, message, at);
  }

  // function mustBeAVariable(entity, at) { must(entity?.kind === "Variable", `Functions can not appear here`, at); }

  // function mustBeAFunction(entity, at) { must(entity?.kind === "Function", `${entity.name} is not a function`, at); }

  // function mustHaveCorrectArgumentCount(argCount, paramCount, at) {
  //   const equalCount = argCount === paramCount;
  //   must(
  //     equalCount,
  //     `${paramCount} argument(s) required but ${argCount} passed`,
  //     at
  //   );
  // }
  function mustHaveInitializerMatchingType(initializer, type, at) {
    // console.log(`Initializer: ${initializer}`, type, at)
    // console.log(`Type: ${type.kind}`)
    must(
      typeDescription(initializer.type) == type,
      `Initializer must be of type ${type}`,
      at
    );
  }

  const builder = match.matcher.grammar.createSemantics().addOperation("rep", {
    Program(statements) {
      return core.program(statements.children.map((s) => s.rep()));
    },

    //==================== (VALID STATEMENTS) ====================//
    Stmt_print(_print, _lparen, exp, _rparen, _semicolon) {
      return core.printStatement(exp.rep());
    },

    //Variable Declaration
    // var x: int = 5;
    // modifier: "var"
    // id: "x"
    // type: "int"
    // exp: 5

    Stmt_vardec(modifier, id, _colon, type, _eq, exp, _semicolon) {
      // TODO: Need to do something else with the 'type'
      // const lmaoYeet = exp.sourceString == "None"
      const initializer = exp.rep();
      // if (lmaoYeet) {
      //   initializer = core.voidType
      // }
      // console.log(`Passed in type: ${type.rep()}`)
      const readOnly = modifier.sourceString === "const";
      // console.log(types[type.sourceString])

      //PROBLEM

      const varType = primitiveTypeMapper(type.sourceString);
      // god awful hack
      // console.log(`A proper integer should be seen as ${util.inspect(core.intType, {showHidden: false, depth: null, colors: true})}`)
      // console.log(`mapper for int is ${util.inspect(primitiveTypeMapper("int"), {showHidden: false, depth: null, colors: true})}`)
      console.log(
        `${id.sourceString} is typed to be ${
          type.sourceString
        } which is being identified as ${util.inspect(varType, {
          showHidden: false,
          depth: null,
          colors: true,
        })}`
      );
      console.log(
        `initialized to ${exp.sourceString} of type ${util.inspect(
          initializer.type,
          { showHidden: false, depth: null, colors: true }
        )}`
      );

      // mustHaveInitializerMatchingType(varType, type, { at: exp });
      // equivalent(varType, initializer.type)
      const variable = core.variable(id.sourceString, readOnly, varType);

      mustNotAlreadyBeDeclared(id.sourceString, { at: id });
      // TODO: Add type checking
      // exp must be of type 'type'
      context.add(id.sourceString, variable);
      // Need to make sure this we can both read and write to this variable

      return core.variableDeclaration(variable, varType, initializer);
    },

    //Assignment
    Stmt_assign(variable, ops, _eq, exp, _semicolon) {
      const source = exp.rep();
      const target = variable.rep();
      mustBeAssignable(source, { toType: target.type }, { at: exp });
      mustNotBeReadOnly(target, { at: id });
      // if (ops != "") {
      //   return core.assignment(target, core.binary(ops, target, exp.rep(), target.type));
      // }
      return core.assignment(target, source);
    },

    //Call
    Stmt_call(call, _semicolon) {
      return call.rep();
    },

    //Pass
    Stmt_pass(_pass, _semicolon) {
      return core.passStatement();
    },

    //Break
    Stmt_break(breakKeyword, _semicolon) {
      mustBeInLoop(context, { at: breakKeyword });
      return core.breakStatement;
    },

    //Return
    Stmt_return(returnKeyword, exp, _semicolon) {
      mustBeInAFunction({ at: returnKeyword });
      mustReturnSomething(context.function, { at: returnKeyword });
      const returnExpression = exp.rep();
      mustBeReturnable(
        returnExpression,
        { from: context.function },
        { at: exp }
      );
      return core.returnStatement(returnExpression);
    },

    //Function Declaration
    FuncDecl(type, id, parameters, block) {
      // Start by making the function, but we don't yet know its type.
      // Also add it to the context so that we can have recursion.
      const fun = core.fun(id.sourceString);
      mustNotAlreadyBeDeclared(id.sourceString, { at: id });
      context.add(id.sourceString, fun);

      // Parameters are part of the child context
      context = context.newChildContext({ inLoop: false, function: fun });
      const params = parameters.rep();
      // Now that the parameters are known, we compute the function's type.
      // This is fine; we did not need the type to analyze the parameters,
      // but we do need to set it before analyzing the body.
      const paramTypes = params.map((param) => param.type);
      const returnType = type.children?.[0]?.rep() ?? VOID;
      fun.type = core.functionType(paramTypes, returnType);

      // Analyze body while still in child context
      const body = block.rep();

      // Go back up to the outer context before returning
      context = context.parent;
      return core.functionDeclaration(fun, params, body);
    },

    //While
    LoopStmt_while(_while, exp, block) {
      const test = exp.rep();
      mustHaveBooleanType(test, { at: exp });
      context = context.newChildContext({ inLoop: true });
      const body = block.rep();
      context = context.parent;
      return core.whileStatement(test, body);
    },

    //For
    LoopStmt_foreach(_for, iterator, _in, exp, block) {
      const iterable = exp.rep();
      mustHaveIterableType(iterable, { at: exp });
      return core.forStatement(
        iterator.sourceString,
        iterable.rep(),
        block.rep()
      );
    },

    LoopStmt_range(_for, id, _in, exp1, range, exp2, block) {
      const [low, high] = [exp1.rep(), exp2.rep()];
      mustHaveIntegerType(low, { at: exp1 });
      mustHaveIntegerType(high, { at: exp2 });
      const iterator = core.variable(id.sourceString, INT, true);
      context = context.newChildContext({ inLoop: true });
      context.add(id.sourceString, iterator);
      const body = block.rep();
      context = context.parent;
      return core.forRangeStatement(
        iterator,
        low,
        range.sourceString,
        high,
        body
      );
    },

    Call(id, args) {
      // ids used in calls must have already been declared and must be
      // bound to function entities, not to variable entities.
      const callee = id.rep();
      mustBeCallable(callee, { at: id });
      const exps = args.rep();
      const targetTypes = callee.type.paramTypes;
      mustHaveCorrectArgumentCount(exps.length, targetTypes.length, {
        at: args,
      });
      const argumnts = exps.map((exp, i) => {
        const arg = exp.rep();
        mustBeAssignable(arg, { toType: targetTypes[i] }, { at: exp });
        return arg;
      });
      return core.functionCall(callee, argumnts);
    },

    Args(_open, expList, _close) {
      return expList.asIteration().children;
    },

    // //If
    IfStmt_if(_if, exp, block) {
      const test = exp.rep();
      mustHaveBooleanType(test, { at: exp });
      context = context.newChildContext();
      const consequent = block.rep();
      context = context.parent;
      return core.shortIfStatement(test, consequent);
    },

    IfStmt_else(_if, exp, block1, _else, block2) {
      const test = exp.rep();
      mustHaveBooleanType(test, { at: exp });
      context = context.newChildContext();
      const consequent = block1.rep();
      context = context.parent;
      context = context.newChildContext();
      const alternate = block2.rep();
      context = context.parent;
      return core.ifStatement(test, consequent, alternate);
    },

    IfStmt_elseif(_if, exp, block, _else, trailingIfStatement) {
      const test = exp.rep();
      mustHaveBooleanType(test, { at: exp });
      context = context.newChildContext();
      const consequent = block.rep();
      context = context.parent;
      const alternate = trailingIfStatement.rep();
      return core.ifStatement(test, consequent, alternate);
    },

    TryStmt_catch(_try, block1, _catch, parameters, block2) {
      context = context.newChildContext();
      const tryBlock = block1.rep();
      context = context.parent;
      context = context.newChildContext();
      const params = parameters.rep();
      // context.add(pa)
      const catchBlock = block2.rep();
      context = context.parent;
      return core.tryStatement(tryBlock, catchBlock, params, block3.rep());
    },

    TryStmt_timeout(
      _try,
      block1,
      _timeout,
      block2,
      _catch,
      parameters,
      block3
    ) {
      context = context.newChildContext();
      const tryBlock = block1.rep();
      context = context.parent;
      context = context.newChildContext();
      const timeoutBlock = block2.rep();
      context = context.parent;
      const params = parameters.rep();
      return core.tryStatement(tryBlock, timeoutBlock, params, block3.rep());
    },

    Params(_open, paramList, _close) {
      // Returns a list of variable nodes
      return paramList.asIteration().children.map((p) => p.rep());
    },

    Param(id, _colon, type) {
      const param = core.variable(id.sourceString, false, type.rep());
      mustNotAlreadyBeDeclared(param.name, { at: id });
      context.add(param.name, param);
      return param;
    },

    Block(_open, statements, _close) {
      return statements.children.map((s) => s.rep());
    },
    //==================== (EXPRESSIONS) ====================//

    Exp_unwrap(exp1, elseOp, exp2) {
      const [optional, op, alternate] = [
        exp1.rep(),
        elseOp.sourceString,
        exp2.rep(),
      ];
      mustHaveAnOptionalType(optional, { at: exp1 });
      mustBeAssignable(
        alternate,
        { toType: optional.type.baseType },
        { at: exp2 }
      );
      return core.binary(op, optional, alternate, optional.type);
    },

    Factor_unary(unaryOp, exp) {
      const [op, operand] = [unaryOp.sourceString, exp.rep()];
      let type;
      if (op === "-") {
        mustHaveNumericType(operand, { at: exp });
        type = operand.type;
      } else if (op === "!") {
        mustHaveBooleanType(operand, { at: exp });
        type = BOOLEAN;
      } else if (op === "some") {
        type = core.optionalType(operand.type);
      }
      return core.unary(op, operand, type);
    },

    // Exp_await(_await, exp) {
    //   return core.await(exp.rep())
    // }

    Exp0_logicalor(exp1, _or, exp2) {
      let left = exp1.rep();
      mustHaveBooleanType(left, { at: exp1 });
      for (let e of exp2.children) {
        let right = e.rep();
        mustHaveBooleanType(right, { at: e });
        left = core.binary("||", left, right, BOOLEAN);
      }
      return left;
    },

    Disjunct_logicaland(exp, _and, exps) {
      let left = exp.rep();
      mustHaveBooleanType(left, { at: exp });
      for (let e of exps.children) {
        let right = e.rep();
        mustHaveBooleanType(right, { at: e });
        left = core.binary("&&", left, right, BOOLEAN);
      }
      return left;
    },

    Conjunct_comparative(exp1, relOp, exp2) {
      const [left, op, right] = [exp1.rep(), relOp.sourceString, exp2.rep()];

      if (["<", "<=", ">", ">="].includes(op)) {
        mustHaveNumericOrStringType(left, { at: exp1 });
      }
      mustBeTheSameType(left, right, { at: relOp });

      return core.binary(op.sourceString, exp1.rep(), exp2.rep(), BOOLEAN);
    },

    Comp_additive(exp1, addOp, exp2) {
      // plus or minus
      const [left, op, right] = [exp1.rep(), addOp.sourceString, exp2.rep()];
      if (op === "+") {
        mustHaveNumericOrStringType(left, { at: exp1 });
      } else {
        mustHaveNumericType(left, { at: exp1 });
      }
      mustBothHaveTheSameType(left, right, { at: addOp });
      return core.binary(op, left, right, left.type);
    },

    Term_multiplicative(exp1, mulOp, exp2) {
      const [left, op, right] = [exp1.rep(), mulOp.sourceString, exp2.rep()];
      mustHaveNumericType(left, { at: exp1 });
      mustBothHaveTheSameType(left, right, { at: mulOp });
      return core.binary(op, left, right, left.type);
    },

    Factor_exponent(exp1, powerOp, exp2) {
      // exponentiation
      const [left, op, right] = [exp1.rep(), powerOp.sourceString, exp2.rep()];
      mustHaveNumericType(left, { at: exp1 });
      mustBothHaveTheSameType(left, right, { at: powerOp });
      return core.binary(op, left, right, left.type);
    },

    // Primary_wrapped(_some, exp) {

    // },

    Primary_index(exp1, _open, exp2, _close) {
      const [array, index] = [exp1.rep(), exp2.rep()];
      mustHaveArrayType(array, { at: exp1 });
      mustHaveIntegerType(index, { at: exp2 });
      return core.index(array, index);
    },

    Primary_id(id) {
      // ids used in expressions must have been already declared and must
      // be bound to variable entities, not function entities.
      const entity = context.lookup(id.sourceString);
      mustHaveBeenFound(entity, id.sourceString, { at: id });
      return entity;
    },

    ArrayLit_array(_open, expList, _close) {
      const elements = expList.asIteration().children.map((exp) => exp.rep());
      mustAllHaveSameType(elements, { at: expList });
      return core.arrayLiteral(elements);
    },

    ArrayLit_emptyarray(_open, _close) {
      return core.emptyArrayLiteral();
    },

    DictLit(_open, bindings, _close) {
      return core.dictLiteral(
        bindings.asIteration().children.map((b) => b.rep())
      );
    },

    Parens(_open, exp, _close) {
      return exp.rep();
    },
    //Dictionary stuff
    Binding(key, _colon, value) {
      return [key.rep(), value.rep()];
    },
    // arr1 = [Int]()
    //-------------------- (TYPES) -------------------//
    Type_optional(baseType, _question) {
      return core.optionalType(baseType.rep());
    },

    Type_promise(baseType, _promise) {
      return core.promiseType(baseType.rep());
    },

    Type_array(_open, baseType, _close) {
      return core.arrayType(baseType.rep());
    },

    Type_dictionary(_open, baseType1, _colon, type2, _close) {
      return core.dictionaryType(baseType1.rep(), type2.rep());
    },

    Type_function(_open, types, _close, _arrow, retType) {
      const paramTypes = types.asIteration().children.map((t) => t.rep());
      const returnType = retType.rep();
      return core.functionType(paramTypes, returnType);
    },

    Primary_emptyoptional(_no, type) {
      return new core.emptyOptional(type.rep());
    },

    true(_) {
      return true;
    },

    false(_) {
      return false;
    },

    none(_) {
      return null;
    },

    strlit(_openQuote, _chars, _closeQuote) {
      // strings will be represented as plain JS strings, including
      // the quotation marks
      return this.sourceString;
    },

    intlit(_digits) {
      // ints will be represented as plain JS bigints
      return BigInt(this.sourceString);
    },

    floatlit(_whole, _point, _fraction, _e, _sign, _exponent) {
      // floats will be represented as plain JS numbers
      return Number(this.sourceString);
    },

    int(_) {
      return INT;
    },

    float(_) {
      return FLOAT;
    },

    str(_) {
      return STRING;
    },

    bool(_) {
      return BOOLEAN;
    },

    anything(_) {
      return ANY;
    },

    void(_) {
      return VOID;
    },

    _terminal() {
      return this.sourceString;
    },
  });
  return builder(match).rep();
}
