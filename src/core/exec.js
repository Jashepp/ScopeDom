
import {
	noopFn, noopAsyncFn, setUnion, disposeSymbol, isPromise,
	microtaskCache, mtCacheGetDefinedProperty, mtCacheDefineProperty, mtCacheGetPrototypeOf, mtCacheSetPrototypeOf,
	regexMatchAll, regexExec, regexTest, regexMatchAllFirstGroup,
	elementNodeType, commentNodeType, textNodeType,
	getPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn,
	objectProto, nodeProto, elementProto, functionProto, functionAsyncProto, nativeProtos, nativeConstructors,
	isNative, scopeAllowed, defineWeakRef,
	setAttribute, eventRegistry,
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

/**
 * Execute & Build Expressions - the engine that turns ScopeDom expression strings
 * into scope-aware JavaScript functions.
 * 
 * Transforms expression text (such as `count + 1` or `$this.className = 'active'`) into
 * executable JavaScript via code generation (try-catch, with($sdProxy)), caches it per
 * source element to avoid redundant compilation, and resolves which scopes participate in
 * read vs write access.
 * 
 * The proxy execution flow: buildExp generates a function via #generateCode and caches it
 * before returning {runFn, proxy}; runExp calls buildExp and then invokes runFn() to return a result.
 * 
 * @see execExpression
 * @see execExpressionProxy
 * @see execExpResult
 * @see execExpOptionsDefaults
 * @see execExpProxyDefaults
 */

/** @type {object} Frozen null-object used as `unscopables` for expression `with` blocks */
const frozenNullObj = Object.freeze(Object.create(null));

/**
 * Default options for {@link execExpression.buildExp}.
 * 
 * @typedef {object} execExpOptionsDefaults
 */
export const execExpOptionsDefaults = {
	/** @type {string|null} Optional expression-function argument name */
	argument: null,
	/** @type {boolean} Use explicit return statement in generated code */
	useReturn: false,
	/** @type {object|null} Custom `this` binding for generated function, otherwise the proxy itself */
	fnThis: null,
	/** @type {boolean} Enable "use strict" in generated code */
	strictMode: true,
	/** @type {boolean} Generate async function (auto-detected if 'await' in expression) */
	useAsync: false,
	/** @type {boolean} Always return true for property existence checks */
	silentHas: true,
	/** @type {boolean} Hide global variables from expression scopes */
	globalsHide: true,
	/** @type {boolean} Throw error when accessing hidden globals */
	throwGlobals: true,
	/** @type {boolean} Automatically execute the expression (false=build) */
	run: true,
	/** @type {WeakSet<object>|null} Scopes to use own properties for hasOwnProperty checks */
	scopeUseOwn: null,
	/** @type {scopeController|null} Scope controller for signal proxy support */
	scopeCtrl: null,
	/**
	 * Use `useSignalProxy:true` when you want signal-aware expression resolution;
	 * otherwise expressions run without signal proxies.
	 * 
	 * @type {boolean} Auto-create signal proxies for non-primitive values */
	useSignalProxy: false,
	/** @type {boolean} Returns signals instead of auto-resolving their value within #getResolve */
	returnSignals: false,
	/** @type {HTMLElement|null} Source / Original element, for cache keys */
	sourceElement: null,
};

/**
 * Default options for {@link execExpressionProxy}.
 * 
 * @typedef {object} execExpProxyDefaults
 */
const execExpProxyDefaults = {
	/** @type {Set<object>} Primary scopes for expression resolution */
	mainScopes: null,
	/** @type {Set<object>} Scopes to read from (extra scopes) */
	getScopes: null,
	/** @type {Set<object>} Scopes to write to (prototype chain of main scopes) */
	setScopes: null,
	/** @type {WeakSet<object>|null} Scopes to use hasOwnProperty for (auto-created if null) */
	scopeUseOwn: null,
	/** @type {boolean} Always return true for has checks */
	silentHas: true,
	/** @type {object|null} Global object (window) for global access */
	globalObj: null,
	/** @type {boolean|null} Hide globals from expression */
	globalsHide: null,
	/** @type {Function|null} Callback when global access is attempted (globalsHide=true) */
	globalCatch: null,
	/** @type {scopeController|null} Scope controller */
	scopeCtrl: null,
	/** @type {signalController|null} Signal controller for signal proxy support */
	signalCtrl: null,
	/** @type {boolean} Auto-create signal proxies for non-primitive values */
	useSignalProxy: true,
	/** @type {object} Unscopables object to hide specific variables from `with` */
	unscopables: frozenNullObj,
};

/**
 * Result of {@link execExpression.buildExp}.
 * 
 * @typedef {object} execExpResult
 * @property {null|any} result The execution result (null if not run, or Promise if async)
 * @property {object} firstScope The first scope in the getScopes Set
 * @property {Function} runFn The runnable function, wrapped with error console logging
 * @property {Function} logFnError Error logging callback function for expression errors (a bound Function, or noopFn outside DEV)
 * @property {Set<object>} getScopes Set of scopes to read from (for property get operations)
 * @property {Set<object>} setScopes Set of scopes to write to (for property set operations)
 * @property {execExpressionProxy} proxy The Proxy instance wrapping scope access for expressions
 * @property {execExpOptionsDefaults} options The resolved options used for this execution
 */

/**
 * Expression Builder & Executor - the engine that turns ScopeDom expression strings
 * into executable JavaScript functions.
 * 
 * The execExpression class is responsible for transforming expression text
 * (like `count + 1`) into executable functions. It constructs argument lists
 * from scope resolution, generates function bodies, and caches compiled functions
 * to avoid redundant evaluation.
 * 
 * Two entry points:
 * - {@link execExpression.buildExp} - compile an expression into a bound function,
 *   cache it per source element, and return the result object (without executing).
 * - {@link execExpression.runExp} - build the expression and immediately execute it,
 *   returning the result (or a Promise if async).
 * 
 * @see {@link execExpResult} For the result structure of buildExp/runExp
 * @see {@link execExpressionProxy} For the Proxy-based scope access mechanism
 * 
 * @class execExpression
 */
export class execExpression {
	
	/**
	 * TODO: use TrustedScript if passed from scopedom init or options
	 */
	
	/** @type {WeakMap} Cache generated functions to lower memory usage */
	static #expCache = new WeakMap();
	
	/**
	 * Generate the wrapped function code for an expression.
	 * 
	 * Creates a function that:
	 * 1. Wrap with try-catch
	 * 2. Uses `with($sdProxy)` to inject scope variables into the context
	 * 3. Declares local variables ($sdProxy, $sdError, arguments, constructor) to shadow globals
	 * 4. Wraps the expression in a return statement or as an expression statement
	 * 
	 * @private
	 * @param {string} expression The expression to generate code for
	 * @param {execExpOptionsDefaults} options Expression options
	 * @returns {string} Generated function code
	 */
	static #generateCode(expression,options){
		let fnCode
		=`try{with($sdProxy){\n` // `with` statement & proxy to capture variable lookups
		+	`let $sdProxy,$sdError,arguments,constructor;\n` // clear local variables
		+	`${options.strictMode ? "\"use strict\";" : ""}` // strict mode
		+	(options.useReturn ? `return(\n\n${expression}\n\n)` : `\n\n${expression};\n\n/**/`) // expression with optional return
		+`}}catch(e){return $sdError(e),e}`; // error handler
		return fnCode;
	}
	
	/**
	 * Generate the cache key for an expression function.
	 * 
	 * @private
	 * @param {string} expression The expression to generate code for
	 * @param {execExpOptionsDefaults} options Expression options
	 * @param {string} args Expression arguments
	 * @returns {string} Key for this expression, options, name & args combination
	 */
	static #genExpKey(expression,options,args){
		return `${expression}|${args.join(',')}|${options.useAsync?'async':''},${options.strictMode?'strict':''},${options.useReturn?'return':''}`;
	}
	
	/**
	 * Turn scopes to getter & setter lists.
	 * 
	 * setScopes get built from mainScopes & their prototypes, filtered by scopeAllowed().
	 * getScopes is the provided extraScopes.
	 * 
	 * @private
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
	
	/** @type {string[]} Default argument names passed to compiled expression functions */
	static #expDefaultArguments = ['$sdProxy','$sdError'];
	
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
		let { fnThis, useAsync, scopeUseOwn, silentHas, globalsHide, throwGlobals, scopeCtrl, useSignalProxy, returnSignals, argument, sourceElement } = options;
		// Auto-detect async from `await` in expression. Cheap string check; could be more robust but that would add cost to every expression compilation.
		useAsync = options.useAsync = useAsync || expression.indexOf('await')!==-1;
		let globalObj = window, globalCatch = noopFn, unscopables = execExpProxyDefaults.unscopables, args = execExpression.#expDefaultArguments;
		// When globalsHide && throwGlobals: throw on global access attempts
		if(globalsHide && throwGlobals) globalCatch = execExpression.throwGlobalAccessError;
		// Add argument name to unscopables so it doesn't shadow the expression proxy
		if(argument?.length>0){ unscopables = { __proto__:null, [argument]:true }; args = args.concat(argument); }
		// Build getScopes (read) and setScopes (write)
		let { getScopes, setScopes } = execExpression.#parseScopes(mainScopes,extraScopes);
		// Assemble proxy state and create the expression proxy
		let proxyObj = { __proto__:null, ...execExpProxyDefaults, mainScopes, getScopes, setScopes, scopeUseOwn, silentHas, globalObj, globalsHide, globalCatch, scopeCtrl, useSignalProxy, returnSignals, unscopables };
		let proxy = new execExpressionProxy(proxyObj);
		// Expression caching: same expression on same element -> same compiled function
		let runFn, fnKey, expCache = execExpression.#expCache, genFn, cacheMap, logFnError = noopFn;
		if(sourceElement){
			fnKey = this.#genExpKey(expression,options,args);
			if(!expCache.has(sourceElement)) expCache.set(sourceElement,cacheMap = new Map());
			else cacheMap = expCache.get(sourceElement);
			if(cacheMap.has(fnKey)) genFn = cacheMap.get(fnKey);
		}
		// Generate final function code with expression
		if(!genFn) {
			let fnCode = execExpression.#generateCode(expression,options);
			// Get constructor from functionProto or functionAsyncProto (for async function support)
			let fnc = useAsync ? functionAsyncProto.constructor : functionProto.constructor;
			// Create new function & cache it for future reuse on the same source element
			genFn = new fnc(args,fnCode);
			if(cacheMap) cacheMap.set(fnKey,genFn);
		}
		// Error logging callback (DEV builds only - in production noopFn is used)
		DEV: { logFnError = execExpression.#logExpError.bind(null,expression,genFn,proxyObj); }
		// Create function using Function constructor with dynamic arguments; $sdProxy = proxy, $sdError = logFnError
		try{ runFn = genFn.bind(fnThis||proxy,proxy,logFnError); }
		catch(err){ logFnError(err); }
		// Return with extra info for debugging and subsequent execution
		return { __proto__:null, result:null, firstScope:getScopes.values().next().value, runFn, logFnError, getScopes, setScopes, proxy, options };
	}
	
	/**
	 * Throw an error when an expression attempts to access a global variable. Never returns normally.
	 * 
	 * @param {string} key The global variable name that was accessed
	 * @throws {Error} Always throws - this function has no return path
	 */
	static throwGlobalAccessError(key){
		throw new Error("Expression tried to access a global variable: "+key);
	}
	
	/**
	 * Log expression error in DEV mode.
	 * 
	 * @private
	 * @param {string} expression The expression that caused the error
	 * @param {Function} genFn The generated function
	 * @param {execExpProxyDefaults} proxyObj Proxy options state
	 * @param {Error} error The error object
	 */
	static #logExpError(expression,genFn,proxyObj,error){
		console.warn(`ScopeDom: Error on Expression: ${expression}\n`,error?.message,'\n',{ expression, error, genFn, proxyObj });
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
 * Proxy handler that intercepts property operations to resolve scoped expression values.
 * 
 * The execExpressionProxy class is the JavaScript Proxy handler used during expression
 * execution. It intercepts property operations (has, get, set) to map variable names
 * like `count` to scope objects instead of hitting the global scope directly.
 * 
 * Ownership rule (reads vs writes), stated once:
 * - READ traps (`get`/`has`/`getOwnPropertyDescriptor`/`ownKeys`) read `mainScopes` first, then the extra `getScopes` set.
 * - WRITE traps (`set`/`defineProperty`/`deleteProperty`) write `setScopes` first, then fall back to `mainScopes`.
 * 
 * `mainScopes` is used for both reads and writes.
 * `getScopes` is read-only (never written, deleted, or defined).
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
		if(!obj.scopeUseOwn) obj.scopeUseOwn = new WeakSet();
		if(!obj.signalCtrl && obj.scopeCtrl?.signalCtrl) obj.signalCtrl = obj.scopeCtrl.signalCtrl;
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
	static has(obj,prop){
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
	 * Then, if useSignalProxy && signalCtrl: auto-create a signal proxy on a main scope (write-on-read) and return it or the new value; finally return void 0 if nothing matched.
	 * 
	 * @param {string} prop Property name to get
	 * @param {any} receiver The receiver object
	 * @returns {any} Property value
	 */
	static get(obj,prop,receiver){
		if(prop===Symbol.unscopables) return obj.unscopables;
		for(let s of obj.mainScopes) if(hasOwn(s,prop)) return execExpressionProxy.#getResolve(obj,s,prop,s);
		for(let s of obj.getScopes){
			if(obj.scopeUseOwn.has(s)){ if(hasOwn(s,prop)) return execExpressionProxy.#getResolve(obj,s,prop,s); }
			else if(prop in s) return execExpressionProxy.#getResolve(obj,s,prop,s);
		}
		for(let s of obj.mainScopes) if(prop in s) return execExpressionProxy.#getResolve(obj,s,prop,s);
		if(obj.globalObj && hasOwn(obj.globalObj,prop)){
			if(obj.globalsHide) return obj.globalCatch(prop), false;
			else return execExpressionProxy.#getResolve(obj,obj.globalObj,prop,obj.globalObj);
		}
		if(obj.useSignalProxy && obj.signalCtrl){
			for(let s of obj.mainScopes){
				let signal = new signalInstance(obj.signalCtrl,void 0);
				let newValue = obj.signalCtrl.defineProxySignal(s,prop,void 0,signal,true);
				return obj.returnSignals ? signal : newValue;
			}
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
	static set(obj,prop,value,receiver){
		for(let s of obj.setScopes) if(hasOwn(s,prop)) return execExpressionProxy.#setResolve(obj,s,prop,value,s);
		for(let s of obj.mainScopes) return execExpressionProxy.#setResolve(obj,s,prop,value,s);
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
	 * Resolve and return a property value through the expression proxy's get path.
	 * 
	 * This method gets the property value using `Reflect.get`.
	 * 
	 * Signal proxy integration (when `useSignalProxy=true` and `signalCtrl` is available):
	 * 1. If property is already a signal (descriptor.value or descriptor.get[signalSymb]),
	 *    return the signal or its resolved value.
	 * 2. If value is a signalProxy/signalInstance, resolve and return its value.
	 * 3. If value is non-primitive and not already a signal:
	 *    - Check descriptor gate: property is either not defined, or configurable,
	 *      and not getter-only (getter without setter).
	 *    - If gate passes: call defineProxySignal on the target scope to install a
	 *      reactive getter/setter pair, then return the reactive wrapper (write-on-read).
	 *    - Important: this step mutates the target scope object by defining reactive
	 *      getter/setter pairs on the property. This is intentional for signalProxyAll
	 *      mode but is a side effect on read.
	 * 4. Return the value as-is otherwise.
	 * 
	 * @private
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {object} target The scope object containing the property to resolve
	 * @param {string} prop Property name
	 * @param {any} [receiver=target] Receiver object (scope object)
	 * @returns {any} Property value
	 */
	static #getResolve(obj,target,prop,receiver=target){
		let value = Reflect.get(target,prop,target), signalCtrl = obj.signalCtrl;
		// If using signalProxy on all scopes & expressions
		if(obj.useSignalProxy && signalCtrl){
			let signal, descriptor = mtCacheGetDefinedProperty(target,prop);
			// Check if property is a signalInstance
			if(descriptor?.value instanceof signalInstance) signal = descriptor.value;
			else if(descriptor?.get?.[signalSymb] instanceof signalInstance) signal = descriptor.get[signalSymb];
			if(signal){
				return obj.returnSignals ? signal : value;
			}
			// Resolve signal & value
			signal = resolveSignal(value,null,true); // Signal or null
			value = resolveSignal(value,null,false);
			if(signal){
				return obj.returnSignals ? signal : value;
			}
			// Auto-reactive property for non-primitive values
			if(
				!signal
				&& (!descriptor || descriptor?.configurable)
				&& !(descriptor?.get && !descriptor?.set) // Skip get-only descriptors, eg: $signal-name:watch $oldValue
			){
				// This modifies existing scope data
				let signal = new signalInstance(signalCtrl,void 0);
				let newValue = signalCtrl.defineProxySignal(target,prop,value,signal,true);
				return obj.returnSignals ? (signal.record(), signal) : newValue;
			}
		}
		return value;
	}
	
	/**
	 * Resolve and set a property value through the expression proxy's set path.
	 * 
	 * Signal proxy integration (when `useSignalProxy=true` and `signalCtrl` is available):
	 * 1. If the property already has a signal setter (descriptor.set[signalSymb]) or
	 *    a signal value descriptor (descriptor.value instanceof signalInstance),
	 *    delegate to the signal's set method (standard signal update).
	 * 2. If property has no existing descriptor (new property):
	 *    - Resolve the value (unwrap if it's a signalProxy/signalInstance).
	 *    - Create a new signalInstance for primitive values; keep existing signal for signal values.
	 *    - Call defineProxySignal to install reactive getter/setter on the scope, set the value,
	 *      and call signal.changed() to notify observers.
	 * 3. Otherwise: use Reflect.set (plain property write, no signal created - for existing
	 *    non-signal properties or when useSignalProxy is false).
	 * 
	 * @private
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {object} target The scope object to set the property on
	 * @param {string} prop Property name
	 * @param {any} value Property value
	 * @param {any} [receiver=target] Receiver object (scope object)
	 * @returns {boolean} True on success
	 */
	static #setResolve(obj,target,prop,value,receiver=target){
		let descriptor = mtCacheGetDefinedProperty(target,prop), signalCtrl = obj.signalCtrl;
		// If setter or value is a signal, delegate to signal's set method
		if(descriptor?.set?.[signalSymb] instanceof signalInstance) return descriptor.set(value), true;
		if(descriptor?.value instanceof signalInstance) return descriptor.value.set(value), true;
		// If using signalProxy on all scopes & expressions
		if(obj.useSignalProxy && signalCtrl && !descriptor){
			let signal = resolveSignal(value,null,true); // Signal or null
			value = resolveSignal(value,null,false);
			if(!signal){
				signal = new signalInstance(signalCtrl,void 0);
			}
			return signalCtrl.defineProxySignal(target,prop,value,signal,true), signal.changed(), true;
		}
		// Otherwise, standard property set
		return Reflect.set(target,prop,value,target);
	}
	
}
