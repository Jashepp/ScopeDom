
import {
	noopFn, noopAsyncFn, setUnion, disposeSymbol, isPromise,
	microtaskCache, mtCacheGetDefinedProperty, mtCacheDefineProperty, mtCacheGetPrototypeOf, mtCacheSetPrototypeOf,
	regexMatchAll, regexExec, regexTest, regexMatchAllFirstGroup,
	elementNodeType, commentNodeType, textNodeType,
	getPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn,
	objectProto, nodeProto, elementProto, functionProto, functionAsyncProto, nativeProtos, nativeConstructors,
	isNative, scopeAllowed, defineWeakRef,
	isElementLoaded, setAttribute, eventRegistry,
} from "./utils.js";
import {
	timing,
} from "./timing.js";
import {
	signalController, signalObserver, signalProxy, signalInstance, resolveSignal, signalSymb,
} from "./signal.js";
import {
	scopeInstance, scopeBase, scopeControllerContext, scopeController, scopeElementContext, scopeElementController,
} from "./scope.js";

const frozenNullObj=Object.freeze(Object.create(null));

/**
 * Default options for {@link execExpression.buildExp}.
 * 
 * @template {object} execExpOptionsDefaults
 * @typedef {object} execExpOptionsDefaults
 */
const execExpOptionsDefaults = {
	/** @type {boolean} Optional argument name for the expression function (used for $sdcArgument) */
	argument: null,
	/** @type {boolean} Use explicit return statement in generated code */
	useReturn: false,
	/** @type {boolean} Custom `this` binding for generated function, otherwise the proxy itself */
	fnThis: null,
	/** @type {boolean} Return raw function without error logging wrapper */
	fnRaw: false,
	/** @type {boolean} Enable "use strict" in generated code */
	strictMode: true,
	/** @type {boolean} Generate async function (auto-detected if 'await' in expression) */
	useAsync: false,
	/** @type {boolean} Always return true for property existence checks */
	silentHas: true,
	/** @type {boolean} Hide global variables from expression scopesc */
	globalsHide: true,
	/** @type {boolean} Throw error when accessing hidden globals */
	throwGlobals: true,
	/** @type {boolean} Automatically execute the expression (false=build) */
	run: true,
	/** @type {Set<object>|null} Scopes to use own properties for hasOwnProperty checks */
	scopeUseOwn: null,
	/** @type {object|null} Scope controller for signal proxy support */
	scopeCtrl: null,
	/** @type {boolean} Auto-create signal proxies for non-primitive values */
	useSignalProxy: false
};

/**
 * Default options for {@link execExpressionProxy}.
 * 
 * @template {object} execExpProxyDefaults
 * @typedef {object} execExpProxyDefaults
 */
const execExpProxyDefaults = {
	/** @type {Set<object>} Primary scopes for expression resolution */
	mainScopes: null,
	/** @type {Set<object>} Scopes to read from (extra scopes) */
	getScopes: null,
	/** @type {Set<object>} Scopes to write to (prototype chain of main scopes) */
	setScopes: null,
	/** @type {WeakSet|null} Scopes to use hasOwnProperty for (auto-created if null) */
	scopeUseOwn: null,
	/** @type {boolean} Always return true for has checks */
	silentHas: true,
	/** @type {object|null} Global object (window) for global access */
	globalObj: null,
	/** @type {boolean} Hide globals from expression */
	globalsHide: null,
	/** @type {boolean} Callback when global access is attempted (globalsHide=true) */
	globalCatch: null,
	/** @type {object|null} Scope controller for signal proxy support */
	scopeCtrl: null,
	/** @type {boolean} Auto-create signal proxies for non-primitive values */
	useSignalProxy: true,
	/** @type {object} Unscopables object to hide specific variables from `with` */
	unscopables: frozenNullObj,
};

/**
 * Result of {@link execExpression.buildExp}.
 * 
 * @template {object} execExpResult
 * @typedef {object} execExpResult
 * @property {null|any} result The execution result (null if not run, or Promise if async)
 * @property {object} firstScope The first scope in the getScopes Set
 * @property {Function} function The generated expression function
 * @property {Function} runFn The runnable function, wrapped with error logging, or raw function if fnRaw=true
 * @property {Error|any} logFnError Error logging callback function for expression errors
 * @property {Set<object>} getScopes Set of scopes to read from (for property get operations)
 * @property {Set<object>} setScopes Set of scopes to write to (for property set operations)
 * @property {execExpressionProxy} proxy The Proxy instance wrapping scope access for expressions
 * @property {execExpOptionsDefaults} options The resolved options used for this execution
 */

/**
 * Build & Execute Expressions for ScopeDom.
 * 
 * This class provides static methods to build and execute JavaScript expressions
 * within the context of ScopeDom scopes. It generates wrapper functions that
 * use the `with` statement to inject scope variables, and creates Proxy objects
 * for dynamic scope access during expression execution.
 * 
 * Key features:
 * - Dynamic code generation from expression strings
 * - Multi-scope resolution (main scopes, extra scopes, global objects)
 * - Async expression support (auto-detected via 'await' keyword)
 * - Signal integration for reactive property access
 * - Error handling and logging for expression failures
 * 
 * @class execExpression
 * @see {@link execExpResult} For the result structure of buildExp/runExp
 * @see {@link execExpressionProxy} For the Proxy-based scope access mechanism
 */
export class execExpression {
	
	/**
	 * Generate wrapper code for an expression.
	 * 
	 * Creates a function that:
	 * 1. Uses `with($sdcScope)` to inject scope variables into the context
	 * 2. Declares local variables ($sdcScope, arguments, constructor) to shadow globals
	 * 3. Generates either async or sync function based on options
	 * 4. Wraps the expression in a return statement or as an expression statement
	 * 5. Applies the function to the proxy context
	 * 
	 * @param {string} expression The expression to generate code for
	 * @param {execExpOptionsDefaults} options Execution options
	 * @param {string} fnNameSuffix Suffix for function name
	 * @returns {string} Generated function code
	 */
	static #generateCode(expression,options,fnNameSuffix){
		let { useAsync, strictMode, useReturn } = options;
		let fnName = '$sdcExp'+(fnNameSuffix?.length>0 ? "_"+fnNameSuffix.replace(/[^A-Za-z0-9]/g,'_') : ''), fnCode
		=`with($sdcScope){` // `with` statement & proxy to capture variable lookups
		+	`let $sdcScope,arguments,constructor;` // local vars shadow potential globals
		+	`return${useAsync ? "(async " : "(" }function ${fnName}(){` // async if expression uses await
		+		`${strictMode ? "\"use strict\";" : ""}${useAsync ? "let $sdcCatchError;" : ""}` // error handler for async
		+		(useReturn ? `return (\n\n${expression}\n\n);` : `\n\n${expression};\n\n/**/`) // return or expression
		+	`}).apply(this)${useAsync?".catch($sdcCatchError);":";"}` // async catch or semicolon
		+`}`;
		return fnCode;
	}
	
	/**
	 * Turn scopes to getter & setter lists.
	 * 
	 * setScopes get built from mainScopes & their prototypes, filtered by scopeAllowed().
	 * getScopes is the provided extraScopes.
	 * 
	 * @param {Array<object>|Set<object>} mainScopes Main scopes
	 * @param {Array<object>|Set<object>} extraScopes Extra scopes
	 * @returns {{getScopes:Set<object>, setScopes:Set<object>}} Parsed scopes
	 */
	static #parseScopes(mainScopes,extraScopes){
		if(!(mainScopes instanceof Set)) mainScopes = new Set(mainScopes);
		if(!(extraScopes instanceof Set)) extraScopes = new Set(extraScopes);
		let setScopes = new Set();
		// Traverse prototype chain for each main scope, adding only allowed scopes
		for(let ms of mainScopes) for(let s=ms; s && scopeAllowed(s); s=mtCacheGetPrototypeOf(s)) setScopes.add(s);
		return { getScopes:extraScopes, setScopes };
	}
	
	/**
	 * Expression Executor / Builder.
	 * 
	 * @param {string} expression The expression
	 * @param {Array<object>|Set<object>} mainScopes List of main scopes
	 * @param {Array<object>|Set<object>} extraScopes List of extra scopes
	 * @param {execExpOptionsDefaults} options Expression options
	 * @returns {execExpResult} Built expression executor result
	 */
	static buildExp(expression,mainScopes,extraScopes=[],options={}){
		if(expression!==String(expression)) throw new Error("Invalid expression: "+expression);
		options = { __proto__:null, ...execExpOptionsDefaults, ...options };
		let { fnThis, useAsync, scopeUseOwn, silentHas, globalsHide, throwGlobals, scopeCtrl, useSignalProxy, argument, fnRaw } = options;
		// Auto-detect async if expression contains 'await'. This could be done in a better way, but that would sacrifice performance.
		useAsync = options.useAsync = useAsync || expression.indexOf('await')!==-1;
		let globalObj = window, globalCatch = noopFn, unscopables = execExpProxyDefaults.unscopables, args = ['$sdcScope','$sdcCatchError'];
		// If both globalsHide and throwGlobals are true, throw on global access
		if(globalsHide && throwGlobals) globalCatch = (key)=>{ throw new Error("Expression tried to access a global variable: "+key); };
		// If argument is provided, add it to unscopables
		if(argument?.length>0){ unscopables = { [argument]:true }; args.push(argument); }
		// Turn mainScopes & extraScopes into getScopes & setScopes
		let { getScopes, setScopes } = execExpression.#parseScopes(mainScopes,extraScopes);
		// Create proxy with resolved options
		let proxy = new execExpressionProxy({ ...execExpProxyDefaults, mainScopes, getScopes, setScopes, scopeUseOwn, silentHas, globalObj, globalsHide, globalCatch, scopeCtrl, useSignalProxy, unscopables });
		// Generate final function code with expression
		let fnCode = execExpression.#generateCode(expression,options,proxy.$attribute);
		// Get constructor from functionProto or functionAsyncProto
		let fn, fnc = useAsync ? functionAsyncProto.constructor : functionProto.constructor;
		// Error logging callback
		let logFnError = (err)=>console.warn(`ScopeDom: Error on Expression: ${expression}\n`,err.message,'\n',{ expression, fnCode, function:fn, mainScopes, getScopes, setScopes, result:err });
		// Create function using Function constructor with dynamic arguments
		try{ fn = (new fnc(args,fnCode)).bind(fnThis||proxy,proxy,logFnError); }
		catch(err){ logFnError(err); }
		// Create runFn wrapper with error handling (unless fnRaw)
		let runFn = !fn ? noopFn : (fnRaw ? fn : function $sdcExpRun(a){ try{ return fn(a); }catch(err){ return logFnError(err),err; } });
		// Return with extra info for debugging
		return { __proto__:null, result:null, firstScope:getScopes.values().next().value, function:fn, runFn, logFnError, getScopes, setScopes, proxy, options };
	}
	
	/**
	 * Build + Run the Expression Executor / Builder.
	 * 
	 * If options.run=false, the expression is built but not executed, allowing the generated function to be cached & reused.
	 * 
	 * @param {string} expression The expression
	 * @param {Array<object>|Set<object>} mainScopes List of main scopes
	 * @param {Array<object>|Set<object>} extraScopes List of extra scopes
	 * @param {execExpOptionsDefaults|object|null} options Expression options
	 * @returns {execExpResult} Built expression executor result
	 */
	static runExp(expression,mainScopes,extraScopes=[],options={}){
		let exec = execExpression.buildExp(expression,mainScopes,extraScopes,options);
		let { runFn, logFnError, options:{ useAsync, run } } = exec;
		if(run===false) return exec;
		exec.result = runFn();
		// Handle async errors: noop for async (caught by Promise), log for sync
		if(exec.result instanceof Promise) exec.result.catch(useAsync?noopFn:logFnError);
		return exec;
	}
	
}

/**
 * ScopeDom Proxy for expression execution, used in with(proxy).
 * 
 * This class implements the JavaScript Proxy handler for scope access during expression execution.
 * It intercepts property operations (has, get, set, etc.) to resolve values from scope chains.
 * The proxy works in conjunction with the `with` statement in the generated function to provide seamless scope variable access.
 * 
 * It handles:
 * - Property existence checks (has)
 * - Property value retrieval (get) with signal integration
 * - Property value setting (set) with signal integration
 * - Property descriptor operations
 * - Signal proxy auto-creation for reactive properties
 * 
 * @class execExpressionProxy
 * @implements {ProxyHandler}
 * @see {@link execExpProxyDefaults} For default options
 * @see {@link signalProxy} For signal proxy integration
 */
export class execExpressionProxy {
	
	/**
	 * Use Proxy options as base Proxy object & state.
	 * 
	 * The constructor returns a new Proxy, making it act as both a constructor and a factory function.
	 * This allows configuration before the Proxy is created.
	 * 
	 * @constructor
	 * @param {execExpProxyDefaults|object} obj Proxy options/state
	 */
	constructor(obj){
		obj = { __proto__:null, ...execExpProxyDefaults, ...obj };
		if(!obj.scopeUseOwn) obj.scopeUseOwn = new WeakSet();
		return new Proxy(obj,execExpressionProxy);
	}
	
	/**
	 * Check if a property exists.
	 * 
	 * Resolution order:
	 * 1. If silentHas=true, always return true
	 * 2. Check mainScopes with hasOwn
	 * 3. Check getScopes with scopeUseOwn set (hasOwn vs in operator)
	 * 4. Check mainScopes with in operator
	 * 5. Check globalObj with globalCatch if needed
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {string} prop Property name to check
	 * @returns {boolean} True if property exists
	 */
	static has = function execExpHas(obj,prop){
		if(obj.silentHas) return true;
		for(let ms of obj.mainScopes) if(hasOwn(ms,prop)) return Reflect.has(ms,prop);
		for(let s of obj.getScopes){
			if(obj.scopeUseOwn.has(s)){ if(hasOwn(s,prop)) return Reflect.has(s,prop); }
			else if(prop in s) return Reflect.has(s,prop);
		}
		for(let ms of obj.mainScopes) if(prop in ms) return Reflect.has(ms,prop);
		if(obj.globalObj && hasOwn(obj.globalObj,prop)){
			if(obj.globalsHide) return obj.globalCatch(prop), false;
			else return Reflect.has(obj.globalObj,prop);
		}
		return false;
	}
	
	/**
	 * Get a property value.
	 * 
	 * Resolution order:
	 * 1. Return unscopables if accessing Symbol.unscopables
	 * 2. Check mainScopes with hasOwn
	 * 3. Check getScopes with scopeUseOwn set (hasOwn vs in operator)
	 * 4. Check mainScopes with in operator
	 * 5. Check globalObj with globalCatch if needed
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {string} prop Property name to get
	 * @param {any} receiver The receiver object
	 * @returns {any} Property value
	 */
	static get = function execExpGet(obj,prop,receiver){
		if(prop===Symbol.unscopables) return obj.unscopables;
		for(let ms of obj.mainScopes) if(hasOwn(ms,prop)) return execExpressionProxy._getResolve(obj,ms,prop,ms);
		for(let s of obj.getScopes){
			if(obj.scopeUseOwn.has(s)){ if(hasOwn(s,prop)) return execExpressionProxy._getResolve(obj,s,prop,s); }
			else if(prop in s) return execExpressionProxy._getResolve(obj,s,prop,s);
		}
		for(let ms of obj.mainScopes) if(prop in ms) return execExpressionProxy._getResolve(obj,ms,prop,ms);
		if(obj.globalObj && hasOwn(obj.globalObj,prop)){
			if(obj.globalsHide) return obj.globalCatch(prop), false;
			else return execExpressionProxy._getResolve(obj,obj.globalObj,prop,obj.globalObj);
		}
		return void 0;
	}
	
	/**
	 * Set a property value.
	 * 
	 * Resolution order:
	 * 1. Check setScopes with hasOwn
	 * 2. Fallback to mainScopes, setting or creating the property with the value
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {string} prop Property name to set
	 * @param {any} value Value to set
	 * @param {any} receiver The receiver object
	 * @returns {boolean} True if property was set
	 */
	static set = function execExpSet(obj,prop,value,receiver){
		for(let s of obj.setScopes) if(hasOwn(s,prop)) return execExpressionProxy._setResolve(obj,s,prop,value,s);
		for(let s of obj.mainScopes) return execExpressionProxy._setResolve(obj,s,prop,value,s);
		return false;
	}
	
	/**
	 * Get property descriptor.
	 * 
	 * Resolution order:
	 * 1. Check mainScopes with hasOwn
	 * 2. Check getScopes with hasOwn
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {string} prop Property name
	 * @returns {PropertyDescriptor|undefined} Property descriptor
	 */
	static getOwnPropertyDescriptor(obj,prop){
		for(let s of obj.mainScopes) if(hasOwn(s,prop)) return mtCacheGetDefinedProperty(s,prop);
		for(let s of obj.getScopes) if(hasOwn(s,prop)) return mtCacheGetDefinedProperty(s,prop);
		return void 0;
	}
	
	/**
	 * Define property descriptor.
	 * 
	 * Resolution order:
	 * 1. Check setScopes with hasOwn
	 * 2. Fallback to mainScopes, defining the property with the descriptor
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {string} prop Property name
	 * @param {PropertyDescriptor} descriptor Property descriptor
	 * @returns {boolean} True if property was defined
	 */
	static defineProperty(obj,prop,descriptor){
		for(let s of obj.setScopes) if(hasOwn(s,prop)) return mtCacheDefineProperty(s,prop,{ __proto__:null, ...descriptor });
		for(let s of obj.mainScopes) return mtCacheDefineProperty(s,prop,{ __proto__:null, ...descriptor });
		return false;
	}
	
	/**
	 * Delete property.
	 * 
	 * Resolution order:
	 * 1. Check setScopes with hasOwn
	 * 2. Check mainScopes with hasOwn
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {string} prop Property name
	 * @returns {boolean} True if property was deleted
	 */
	static deleteProperty(obj,prop){
		for(let s of obj.setScopes) if(hasOwn(s,prop)){ delete s[prop]; return true; }
		for(let s of obj.mainScopes) if(hasOwn(s,prop)){ delete s[prop]; return true; }
		return false;
	}
	
	/**
	 * Get all own keys, from mainScopes & getScopes.
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @returns {string[]} Array of property names
	 */
	static ownKeys(obj){
		return Array.from(new Set(
			[obj.mainScopes,obj.getScopes].map(v=>Array.from(v)).flat(1)
			.reduce((result,item)=>result.concat(Object.keys(item)),[])
		));
	}
	
	/**
	 * Check if extensible.
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @returns {boolean} True if extensible
	 */
	static isExtensible(obj){
		return Array.from(obj.setScopes).length>0;
	}
	
	/**
	 * Construct a new instance (not applicable).
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {any[]} argumentsList Arguments list
	 * @param {Function} newTarget New target
	 */
	static construct(obj,argumentsList,newTarget){}
	
	/**
	 * Apply a function (not applicable).
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {any} thisArgument This argument
	 * @param {any[]} argumentsList Arguments list
	 */
	static apply(obj,thisArgument,argumentsList){}
	
	/**
	 * Deny Set prototype.
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {object} prototype Prototype
	 * @returns {boolean} False
	 */
	static setPrototypeOf(obj,prototype){ return false; }
	
	/**
	 * Get prototype of first main scope.
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @returns {object} Prototype
	 */
	static getPrototypeOf(obj){ return mtCacheGetPrototypeOf(obj.mainScopes[0]); }
	
	/**
	 * Allow extensions.
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @returns {boolean} False
	 */
	static preventExtensions(obj){ return false; }
	
	/**
	 * Resolve and get a property value. Also handles signals.
	 * 
	 * This method:
	 * 1. Gets the property value using Reflect.get
	 * 2. If useSignalProxy:
	 *    2a. Checks if the value or its descriptor is a signalInstance
	 *    2b. If a configurable value isn't a signal and isn't primitive, it auto-creates a signal proxy for reactive access
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {object} target Target object
	 * @param {string} prop Property name
	 * @param {any} [receiver=target] Receiver object
	 * @returns {any} Property value
	 */
	static _getResolve = function execExpGetResolve(obj,target,prop,receiver=target){
		let value = Reflect.get(target,prop,target), signalCtrl = obj.scopeCtrl?.signalCtrl;
		// If using signalProxy on all scopes & expressions
		if(obj.useSignalProxy && signalCtrl){
			let signal, descriptor = mtCacheGetDefinedProperty(target,prop);
			// Check if value or descriptor value is a signal
			if(value instanceof signalInstance) signal = value;
			else if(descriptor?.value instanceof signalInstance) signal = descriptor.value;
			else if(descriptor?.get?.[signalSymb] instanceof signalInstance) signal = descriptor.get[signalSymb];
			if(signal) return signal.get();
			// If no signal, and value isn't primitive, create signalProxy for automatic reactive property access
			if(descriptor?.configurable && !signal && value===Object(value)){
				// This modifies existing scope data
				return signalCtrl.defineProxySignal(target,prop,value);
			}
		}
		return value;
	}
	
	/**
	 * Resolve and set a property value. Also handles signals.
	 * 
	 * This method:
	 * 1. Gets the property descriptor
	 * 2. If the setter or value is a signalInstance, delegates to the signal's set method
	 * 3. Otherwise, uses Reflect.set for standard property setting
	 * 
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {object} target Target object
	 * @param {string} prop Property name
	 * @param {any} value Property value
	 * @param {any} [receiver=target] Receiver object
	 * @returns {boolean} True on success
	 */
	static _setResolve = function execExpSetResolve(obj,target,prop,value,receiver=target){
		let descriptor = mtCacheGetDefinedProperty(target,prop), signalCtrl = obj.scopeCtrl?.signalCtrl;
		// If setter or value is a signal, delegate to signal's set method
		if(descriptor?.set?.[signalSymb] instanceof signalInstance) return descriptor.set(value), true;
		if(descriptor?.value instanceof signalInstance) return descriptor.value.set(value), true;
		// If using signalProxy on all scopes & expressions
		if(obj.useSignalProxy && signalCtrl && !descriptor){
			let signal = new signalInstance(signalCtrl,value);
			return signalCtrl.defineProxySignal(target,prop,value,signal,true), true;
		}
		// Otherwise, standard property set
		return Reflect.set(target,prop,value,target);
	}
	
}
