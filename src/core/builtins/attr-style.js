
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

const attrStyleDefaultSymbol = Symbol('$attrStyleDefault');
const attrStyleAbortSymbol = Symbol('$attrStyleAbortSymbol');
const attrStyleClearProp = [ null, false ];

export class attrStyle {
	
	/**
	 * $style attribute handler: update css properties from expression result.
	 * 
	 * @param {HTMLElement} element The element
	 * @param {scopeElementAttribDefaults} attrib The $style attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 * @param {string|null} [value] Expression value
	 * @param {Array<Function>} onReadyQueue Queue for deferred callbacks
	 */
	static attrStyle(instance,element,attrib,elementScopeCtrl,options,value,onReadyQueue){
		let { attribute:$attribute } = attrib;
		let defaultStyles = element.getAttribute('style') ?? '';
		element[attrStyleDefaultSymbol] = defaultStyles;
		element[attrStyleAbortSymbol] = { __proto__:null, abort:false };
		let { runFn } = instance.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute, $original:defaultStyles },{ __proto__:null, run:false, useReturn:true });
		let obs = instance.scopeCtrl.signalCtrl.createObserver();
		runFn = obs.wrapRecorder(runFn);
		let computeState = { __proto__:null, currentProps:[] };
		let computeFn = attrStyle.attrStyle_compute.bind(null,element,obs,runFn,defaultStyles,computeState);
		let renderFn = attrStyle.attrStyle_render.bind(null,element);
		let updateFn = timing.queueComputeThenRender.bind(null,computeFn,renderFn);
		onReadyQueue.push(updateFn);
		obs.addListener(updateFn);
		instance.registerElementRelatedEvent(element,obs.clear.bind(obs));
		let removeListener = elementScopeCtrl.ctrl.$on('$update',updateFn,{},true);
		instance.registerElementRelatedEvent(element,removeListener);
	}
	
	/**
	 * Undo $style attribute changes on element disconnect.
	 * 
	 * Restores the element's original `style` attribute from the default value stored during
	 * attrStyle setup. If the default was empty, removes the `style` attribute entirely.
	 * Sets the abort flag so no further renders occur after restore.
	 * 
	 * @param {HTMLElement} element The element being disconnected
	 * @param {scopeElementAttribDefaults} attrib The $style attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 */
	static attrStyleUndo(instance,element,attrib,elementScopeCtrl,options){
		if(!(attrStyleDefaultSymbol in element)) return;
		let value = element[attrStyleDefaultSymbol];
		if((value??'')==='') element.removeAttribute('style');
		else element.setAttribute('style',value);
		delete element[attrStyleDefaultSymbol];
		element[attrStyleAbortSymbol].abort = true;
	}
	
	/**
	 * Compute the new styles from the $style expression result.
	 * 
	 * Clears signal observations for the current frame, then evaluates the compiled
	 * expression through the observer's recording scope. Handles three result types:
	 *  - string: concatenated with default styles (semicolon-separated)
	 *  - Array / Set: filtered, joined, and appended after default styles
	 *  - Map / Object: processed as style property-value map with conditional and
	 *    !important handling; removed properties are marked for cleanup
	 * Returns the computed style string or object for rendering.
	 * 
	 * @param {HTMLElement} element The target element
	 * @param {signalObserver} obs The signal observer used for recording signal access
	 * @param {Function} runFn Compiled expression function (wrapped by obs.wrapRecorder)
	 * @param {string} defaultStyles Original `style` attribute value at connect time
	 * @param {object} computeState State object tracking current property list
	 * @returns {string|object|undefined} The computed style for rendering, or undefined if the abort flag is set
	 */
	static attrStyle_compute(element,obs,runFn,defaultStyles,computeState){
		if(element[attrStyleAbortSymbol].abort) return;
		obs.clearSignals();
		let result = runFn();
		// String
		if(typeof result==='string') return defaultStyles.length>0 ? defaultStyles+';'+result : result;
		// If array, simply append it after default styles
		else if(result instanceof Array || result instanceof Set){
			let styleList = Array.from(result).filter(attrStyle.attrStyle_filterArray);
			return defaultStyles.length>0 ? defaultStyles+';'+styleList.join(';') : styleList.join(';');
		}
		// Object
		else if(result===Object(result)){
			let stylesObjEntries = result instanceof Map ? Array.from(result.entries()) : Object.entries(result);
			let stylesObj = Object.fromEntries(stylesObjEntries);
			// Set new properties
			for(let [k,v] of stylesObjEntries){ // { prop:value } { prop: cond ? value : '' }
				if(v instanceof Array){
					if(v.length===2) v = v[0] ? v[1] : null; // { prop:[cond,value] }
					else if(v.length===3) v = v[0] ? v[1] : v[2]; // { prop:[cond,valueTrue,valueFalse] }
				}
				if(typeof v==='number') v = String(v);
				if(typeof v==='string'){
					v = v.trim();
					if(v.length>10 && v.substring(v.length-10)==="!important") v = [ v.substring(0,v.length-10).trimEnd(), true ];
					else v = [ v, false ];
				}
				else v = attrStyleClearProp;
				stylesObj[k] = v;
			}
			// Remove old properties that no longer exist in object
			let oldProps = computeState.currentProps;
			let newProps = computeState.currentProps = Object.keys(stylesObj);
			for(let i=0,l=oldProps.length; i<l; i++){
				let k = oldProps[i];
				if(newProps.indexOf(k)===-1) stylesObj[k] = attrStyleClearProp;
			}
			return stylesObj;
		}
	}
	
	/**
	 * Render the computed styles onto the element.
	 * 
	 * Applies styles via `element.setAttribute('style', ...)` for string results,
	 * or `element.style.setProperty()`/`removeProperty()` for object results.
	 * A no-op if the abort flag is set (element disconnected mid-render).
	 * 
	 * @param {HTMLElement} element The target element
	 * @param {string|object} newStyles The computed style string or property-value object
	 */
	static attrStyle_render(element,newStyles){
		if(element[attrStyleAbortSymbol].abort) return;
		if(typeof newStyles==='string'){
			element.setAttribute('style',newStyles??'');
		}
		else if(newStyles===Object(newStyles)){
			for(let [k,[v,i]] of Object.entries(newStyles)){
				if(typeof v==='string' && v.length>0) element.style.setProperty(k,v,i?'important':void 0);
				else element.style.removeProperty(k);
			}
		}
	}
	
	static attrStyle_filterArray(k){ return typeof k==='string' && k.length>0; }
	
}
