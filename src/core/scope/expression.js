import {
	noopFn,noopAsyncFn,setUnion,disposeSymbol,isPromise,
	microtaskCache,mtCacheGetDefinedProperty,mtCacheDefineProperty,mtCacheGetPrototypeOf,mtCacheSetPrototypeOf,
	regexMatchAll,regexExec,regexTest,regexMatchAllFirstGroup,
	elementNodeType,commentNodeType,textNodeType,
	getPrototypeOf,getOwnPropertyDescriptor,defineProperty,hasOwn,
	objectProto,nodeProto,elementProto,functionProto,functionAsyncProto,nativeProtos,nativeConstructors,
	isNative,scopeAllowed,defineWeakRef,
	setAttribute,eventRegistry,
} from "../utils.js";

import { timing } from "../timing.js";
import { execExpression, execExpOptionsDefaults } from "../exec.js";
import ScopeDom from "../../scopedom.js";

/**
 * Scope Expression - gateway between ScopeDom's scope hierarchy and the expression
 * compilation engine (execExpression in exec.js).
 * 
 * Responsibilities:
 * 1. Resolve the full scope chain for an element (walk up parentCtrl chain).
 * 2. Accumulate additional scopes (element scopes, extra scopes, contexts).
 * 3. Resolve the source element for expression caching.
 * 4. Run plugin `onExpression` hooks (allow expression mutation in-place).
 * 5. Delegate to execExpression.buildExp or execExpression.runExp.
 * 
 * The only public method is {@link scopeExpression.prepareExpression} which handles
 * both run-mode (execute now) and build-mode (compile for later).
 * 
 * @class scopeExpression
 */
export class scopeExpression {
	
	/**
	 * Resolve scopes and compile (and optionally execute) an expression for an element.
	 * 
	 * This is the single entry point for all expression execution in ScopeDom.
	 * It assembles the complete scope context, runs plugin expression hooks, then
	 * delegates to execExpression.
	 * 
	 * Execution modes:
	 * - run=true (default): compiles and immediately executes the expression.
	 *   Returns the result object with `.result` populated (a Promise if async).
	 * - run=false: compiles only, returns the result object with `.runFn` you
	 *   can call later. The compiled function is cached per source element.
	 * 
	 * @see {@link execExpResult} The result object structure (typedef defined in exec.js), shared by buildExp and runExp.
	 * 
	 * @param {scopeElementController} eCtrl The scope element controller for the expression
	 * @param {string} expression The expression string to parse, resolve, and evaluate
	 * @param {Array<object>|null} [extraScopes=null] Extra scope objects to include ({},...)
	 * @param {Array<object>|null} [elementScopes=null] Element scopes to include ([[element,scopesArr],...])
	 * @param {object|null} [options=null] Execution options (run, fnThis, hideDocument, globalsHide, useSignalProxy)
	 * @returns {execExpResult} run=false produces a result object whose runFn you can call later; run=true runs it now and populates its .result, or a Promise if async.
	 */
	static prepareExpression(eCtrl,expression,extraScopes=null,elementScopes=null,options=null){
		let instance = eCtrl.ctrl.ScopeDomInstance;
		options = { __proto__:null, ...options, scopeCtrl:eCtrl.ctrl };
		if(!hasOwn(options,'useSignalProxy')) options.useSignalProxy = !!instance.options.signalProxyAll;
		if(!hasOwn(options,'returnSignals')) options.returnSignals = !!execExpOptionsDefaults.returnSignals;
		if(!hasOwn(options,'run')) options.run = execExpOptionsDefaults.run;
		// Scopes state/object
		let scopes = {
			mainScopes: [], // Main scopes
			scopeUseOwn: new WeakSet(), // Objects that use their own properties (not inherited)
			msProtoList: new Set(), // Prototypes of main scopes
			otherScopes: new Set(), // Additional scopes
		};
		// Walk up scope controller hierarchy
		scopeExpression.#iterateMainScopes(eCtrl,scopes);
		// Accumulate additional scopes
		scopeExpression.#iterateOtherScopes(eCtrl,instance,scopes,extraScopes,elementScopes,options);
		// Resolve source element
		scopeExpression.#resolveSourceElement(eCtrl,instance,options);
		// Finalise expression and call plugins
		let finalExp = scopeExpression.#finaliseWithPlugins(eCtrl,instance,scopes,expression,options);
		// Build or execute expression
		if(!options.run){
			return execExpression.buildExp(finalExp,scopes.mainScopes,scopes.otherScopes,options);
		} else {
			return execExpression.runExp(finalExp,scopes.mainScopes,scopes.otherScopes,options);
		}
	}
	
	/**
	 * Collect main scopes by walking up the controller hierarchy.
	 * 
	 * Starting from the element's controller, walks up via `parentCtrl` to collect
	 * each controller's scope into `scopes.mainScopes`. Stops at:
	 * - The root scope controller (parentCtrl is null), or
	 * - An isolated scope controller (isolated=true)
	 * 
	 * Also builds `scopes.msProtoList` from all collected scope prototype chains,
	 * used later to deduplicate during other scope resolution.
	 * 
	 * The first scope pushed is always the element controller's own scope;
	 * subsequent scopes are its ancestors in the hierarchy.
	 * 
	 * @private
	 * @param {scopeElementController} eCtrl Starting controller
	 * @param {object} scopes Scope accumulator object with mainScopes, msProtoList, scopeUseOwn, otherScopes mutated in-place
	 * @returns {void}
	 */
	static #iterateMainScopes(eCtrl,scopes){
		let { mainScopes, msProtoList } = scopes;
		for(let c=eCtrl.ctrl; c; c=c.parentCtrl){
			mainScopes.push(c.scope);
			if(c.isolated) break;
		}
		for(let ms of mainScopes) for(let o=ms; o && scopeAllowed(o); o=mtCacheGetPrototypeOf(o)) msProtoList.add(o);
	}
	
	/**
	 * Accumulate additional (read-only) scopes from multiple sources.
	 * 
	 * Sources processed in order (each scope added to `scopes.otherScopes`):
	 * 1. extraScopes: user-provided extra scope objects
	 * 2. elementScopes: scope objects for associated DOM elements
	 * 3. Element controller contexts: cached element scopes from cacheElementScopeCtrls
	 * 4. Element context: $this, $$(), $parent, DOM event helpers (unless hideDocument=true)
	 * 5. Scope controller context: $update, $emit, $on, $signal, etc.
	 * 
	 * All scopes from sources 1-4 are added to scopeUseOwn (property resolution uses
	 * hasOwnProperty rather than the `in` operator). Each scope is de-duplicated
	 * against existing mainScope prototypes and previously-added otherScopes.
	 * 
	 * @private
	 * @param {scopeElementController} eCtrl Starting controller
	 * @param {ScopeDom} instance The ScopeDom instance (for cacheElementScopeCtrls)
	 * @param {object} scopes Scope accumulator object with scopeUseOwn, msProtoList, otherScopes mutated in-place
	 * @param {Array<object>|null} extraScopes Extra scope objects to include
	 * @param {Array<object>|null} elementScopes Arrays of element/scope pairs to include
	 * @param {object} options Execution options (hideDocument, fnThis, etc)
	 * @returns {void}
	 */
	static #iterateOtherScopes(eCtrl,instance,scopes,extraScopes,elementScopes,options){
		let { scopeUseOwn, msProtoList, otherScopes } = scopes;
		// Add extraScopes and their prototypes
		if(extraScopes?.length > 0){
			for(let s of extraScopes) for(let o=s; o && scopeAllowed(o); o=mtCacheGetPrototypeOf(o)){
				if(!msProtoList.has(o) && !otherScopes.has(o)){
					otherScopes.add(o);
					scopeUseOwn.add(o);
				}
			}
		}
		// Add elementScopes & it's prototypes
		if(elementScopes?.length>0) for(let [e,sArr] of elementScopes) for(let s of sArr){
			// Add element scopes
			for(let o = s; o && scopeAllowed(o); o = mtCacheGetPrototypeOf(o)){
				if(!msProtoList.has(o) && !otherScopes.has(o)){
					otherScopes.add(o);
					scopeUseOwn.add(o);
				}
			}
			// Add element controller scopes from the cached controllers for each element
			let eScopeCtrl = instance?.cacheElementScopeCtrls.get(e);
			if(eScopeCtrl) for(let o=eScopeCtrl.scope; o && scopeAllowed(o); o=mtCacheGetPrototypeOf(o)){
				if(!msProtoList.has(o) && !otherScopes.has(o)){
					otherScopes.add(o);
					scopeUseOwn.add(o);
				}
			}
		}
		// Determine if element context should be included (unless hideDocument=true)
		let elementContext = !options?.hideDocument ? eCtrl.execContext : null;
		if(!hasOwn(options,'fnThis') && !options?.hideDocument) options.fnThis = eCtrl.element;
		// Add current element controller context ($this, $$, etc.)
		if(elementContext) otherScopes.add(elementContext);
		// Add current scope controller context ($update, $on, $emit, $signal, etc.)
		if(eCtrl.ctrl.execContext) otherScopes.add(eCtrl.ctrl.execContext);
	}
	
	/**
	 * Resolve the source element for the expression, used as the WeakMap cache key.
	 * 
	 * Determines which element should be used as the source for the expression by applying
	 * this fallback chain:
	 * 1. If options.sourceElement is already set - skip (already resolved)
	 * 2. Check elementSources cache - maps source elements to their associated nodes
	 * 3. Check elementExtraScopes cache - finds the first HTMLElement in associated scope pairs
	 * 4. If the resolved node is a text node - climb to its parentNode
	 * 5. If nothing found - default to the controller's element
	 * 
	 * Mutates options.sourceElement in-place.
	 * 
	 * @private
	 * @param {scopeElementController} eCtrl The scope element controller
	 * @param {ScopeDom} instance The ScopeDom instance
	 * @param {object} options Execution options mutated in-place with sourceElement
	 * @returns {void}
	 */
	static #resolveSourceElement(eCtrl,instance,options){
		if(options.sourceElement) return;
		let element = eCtrl.element;
		if(instance.elementSources.has(element)) options.sourceElement = instance.elementSources.get(element);
		else if(instance.elementExtraScopes.has(element)) options.sourceElement = instance.elementExtraScopes.get(element).find(scopeExpression.#findIsNode);
		if(options.sourceElement?.nodeType===textNodeType) options.sourceElement = options.sourceElement.parentNode;
		if(!options.sourceElement) options.sourceElement = element;
	}
	
	/**
	 * Identity check: whether a value is a DOM Node instance.
	 * 
	 * Used to find the source element when resolving sourceElement from a list of
	 * extra scopes attached to an element. Extra scopes may be an array of
	 * [node, scopes] pairs - this finds the first DOM Node in the array (typically the element itself).
	 * 
	 * @private
	 * @param {any} e Value to test
	 * @returns {boolean} True if e is a DOM Node instance
	 */
	static #findIsNode(e){ return e instanceof nodeProto.constructor; }
	
	/**
	 * Finalize the expression string by invoking plugin onExpression hooks.
	 * 
	 * Builds a pluginOnElementExpression info object containing the compiled scopes,
	 * expression text, and options. Each plugin with an onExpression hook receives
	 * this object and may mutate `expObj.expression` in-place to customize the
	 * expression before it is compiled and executed. Returns the (possibly modified)
	 * expression string for the caller to compile and run.
	 * 
	 * @private
	 * @param {scopeElementController} eCtrl The element's scope controller
	 * @param {ScopeDom} instance The ScopeDom instance
	 * @param {object} scopes Object with mainScopes and otherScopes arrays
	 * @param {string} expression The original expression text
	 * @param {object} options Execution options
	 * @returns {string} The finalized expression text (possibly modified by plugins)
	 */
	static #finaliseWithPlugins(eCtrl,instance,scopes,expression,options){
		let expObj = { expression, options, mainScopes:scopes.mainScopes, otherScopes:scopes.otherScopes };
		instance.pluginsOnElementExpression(
			new ScopeDom.pluginOnElementExpression(instance,eCtrl.element,eCtrl,expObj)
		);
		// If plugins modified the expression string, update it for builder/execution
		if(expObj.expression!==expression) expression = expObj.expression;
		return expression;
	}
	
}
