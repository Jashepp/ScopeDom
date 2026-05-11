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
 * 
 * @class scopeExpression
 */
export class scopeExpression {
	
	/**
	 * Execute an expression on the element with a list of scopes for context.
	 * 
	 * This method walks up the controller hierarchy to collect mainScopes, then collects
	 * additional scopes from extraScopes and elementScopes while avoiding duplicates.
	 * Then it either runs the expression immediately(run=true) or builds it for later execution(run=false).
	 * 
	 * @param {string} expression The expression to execute
	 * @param {Array<object>|null} [extraScopes=null] Extra scopes to include [{},...]
	 * @param {Array<object>|null} [elementScopes=null] Element scopes to include [[element,scopesArr],...]
	 * @param {execExp.execExpOptions|object|null} [options=null] Execution options(run:true/false)
	 * @returns {any} execExpression result object
	 */
	static prepareExpression(eCtrl,expression,extraScopes=null,elementScopes=null,options=null){
		let instance = eCtrl.ctrl.ScopeDomInstance;
		options = { __proto__:null, ...options, scopeCtrl:eCtrl.ctrl };
		if(!hasOwn(options,'useSignalProxy')) options.run = !!instance.options.signalProxyAll;
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
	 * This method iterates from the current controller to its ancestors until an isolated controller is found or parentCtrl becomes null.
	 * It also builds a set of prototype chains for deduplication purposes and returns scopeUseOwn(for hasOwnProperty checks) and otherScopes.
	 * @returns {{mainScopes: Array<object>, scopeUseOwn: WeakSet, msProtoList: Set, otherScopes: Set}}
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
	 * Accumulate additional scopes from extraScopes and elementScopes.
	 * 
	 * This method adds scopes to the shared set while avoiding duplicates against mainScope prototypes.
	 * It also handles nested element controller scopes via cacheElementScopeCtrls.
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
	 * Resolve the source element for the expression, to use as WeakMap cache key.
	 * 
	 * This method determines which element should be used as the source for the expression,
	 * with fallback logic to find a node from cached extra scopes or defaulting to the current element.
	 */
	static #resolveSourceElement(eCtrl,instance,options){
		if(options.sourceElement) return;
		let element = eCtrl.element;
		if(instance.elementSources.has(element)) options.sourceElement = instance.elementSources.get(element);
		else if(instance.elementExtraScopes.has(element)) options.sourceElement = instance.elementExtraScopes.get(element).find(scopeExpression.#findIsNode);
		if(options.sourceElement?.nodeType===textNodeType) options.sourceElement = options.sourceElement.parentNode;
		if(!options.sourceElement) options.sourceElement = element;
	}
	
	static #findIsNode(e){ return e instanceof nodeProto.constructor; }
	
	/**
	 * Finalise expression and call plugins.
	 * 
	 * This method finalizes the expression by calling plugins via onElementExpression hook.
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
