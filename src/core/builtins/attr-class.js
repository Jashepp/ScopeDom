
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
import {
	timing,
} from "../timing.js";
import {
	execExpression,execExpressionProxy,
} from "../exec.js";
import {
	signalController, signalObserver, signalProxy, signalInstance, resolveSignal, signalSymb,
} from "../signal.js";
import ScopeDom from "../../scopedom.js";

const attrClassDefaultSymbol = Symbol('$attrClassDefault');
const attrClassAbortSymbol = Symbol('$attrClassAbortSymbol');

export class attrClass {
	
	/**
	 * $class attribute handler: append/update class list from expression result.
	 * 
	 * Creates a signalObserver to track the expression's reactivity. When the signal changes,
	 * computes a new class list (appending Array/Set values or applying Object/Map keys) and
	 * renders it via RAF batched DOM update.
	 * 
	 * @param {HTMLElement} element The element
	 * @param {scopeElementAttribDefaults} attrib The $class attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 * @param {string|null} [value] Expression value
	 * @param {Array<Function>} onReadyQueue Queue for deferred callbacks
	 */
	static attrClass(instance,element,attrib,elementScopeCtrl,options,value,onReadyQueue){
		let { attribute:$attribute } = attrib;
		let defaultClasses = element.getAttribute('class') ?? '';
		element[attrClassDefaultSymbol] = defaultClasses;
		element[attrClassAbortSymbol] = { __proto__:null, abort:false };
		let { runFn } = instance.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute, $original:defaultClasses },{ __proto__:null, run:false, useReturn:true });
		let obs = instance.scopeCtrl.signalCtrl.createObserver();
		runFn = obs.wrapRecorder(runFn);
		let computeFn = attrClass.attrClass_compute.bind(null,element,obs,runFn,defaultClasses);
		let renderFn = attrClass.attrClass_render.bind(null,element);
		let updateFn = timing.queueComputeThenRender.bind(null,computeFn,renderFn);
		onReadyQueue.push(updateFn);
		obs.addListener(updateFn);
		instance.registerElementRelatedEvent(element,obs.clear.bind(obs));
		let removeListener = elementScopeCtrl.ctrl.$on('$update',updateFn,{},true);
		instance.registerElementRelatedEvent(element,removeListener);
	}
	
	/**
	 * Undo $class attribute changes on element disconnect.
	 * 
	 * Restores the element's original `class` attribute from the default value stored during
	 * attrClass setup. If the default was empty, removes the `class` attribute entirely.
	 * Sets the abort flag so no further renders occur after restore.
	 * 
	 * @param {HTMLElement} element The element being disconnected
	 * @param {scopeElementAttribDefaults} attrib The $class attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 */
	static attrClassUndo(instance,element,attrib,elementScopeCtrl,options){
		if(!(attrClassDefaultSymbol in element)) return;
		let value = element[attrClassDefaultSymbol];
		if((value??'')==='') element.removeAttribute('class');
		else element.setAttribute('class',element.className=value);
		delete element[attrClassDefaultSymbol];
		element[attrClassAbortSymbol].abort = true;
	}
	
	/**
	 * Compute the new class list string from the $class expression result.
	 * 
	 * Clears signal observations for the current frame, then evaluates the compiled
	 * expression through the observer's recording scope. Handles three result types:
	 *  - string: concatenated with default classes (space-separated)
	 *  - Array / Set: filtered, joined, and appended after default classes
	 *  - Map / Object: toggles classes on/off using keys as class names and values as booleans
	 * Returns the fully resolved class string for rendering.
	 * 
	 * @param {HTMLElement} element The target element
	 * @param {signalObserver} obs The signal observer used for recording signal access
	 * @param {Function} runFn Compiled expression function (wrapped by obs.wrapRecorder)
	 * @param {string} defaultClasses Original `class` attribute value at connect time
	 * @returns {string|undefined} The computed class string, or undefined if the abort flag is set
	 */
	static attrClass_compute(element,obs,runFn,defaultClasses){
		if(element[attrClassAbortSymbol].abort) return;
		obs.clearSignals();
		let result = runFn();
		if(typeof result==='string') return defaultClasses.length>0 ? defaultClasses+' '+result : result;
		// If array, simply append it after default classes
		else if(result instanceof Array || result instanceof Set){
			let classList = Array.from(result).filter(attrClass.attrClass_filterArray);
			return defaultClasses.length>0 ? defaultClasses+' '+classList.join(' ') : classList.join(' ');
		}
		// If object, disable any existing classes if needed, and add new classes
		else if(result===Object(result)){
			let classObjEntries, newClassList = new Set(defaultClasses.split(' '));
			if(result instanceof Map) classObjEntries = Array.from(result.entries());
			else classObjEntries = Object.entries(result);
			classObjEntries = classObjEntries.filter(attrClass.attrClass_filterEntries);
			for(let [k,v] of classObjEntries){
				if(!v && newClassList.has(k)) newClassList.delete(k);
				else if(v) newClassList.add(k);
			}
			return Array.from(newClassList).join(' ');
		}
	}
	
	/**
	 * Render the computed class list onto the element.
	 * 
	 * Applies the new className string via `element.className`. A no-op if the abort flag
	 * is set (element disconnected mid-render) or if no class string is provided.
	 * 
	 * @param {HTMLElement} element The target element
	 * @param {string} newClassName The computed class string to apply
	 */
	static attrClass_render(element,newClassName){
		if(element[attrClassAbortSymbol].abort) return;
		if(typeof newClassName==='string') element.className = newClassName;
	}
	
	static attrClass_filterArray(k){ return typeof k==='string' && k.length>0; }
	static attrClass_filterEntries([k,v]){ return typeof k==='string' && k.length>0; }
	
}
