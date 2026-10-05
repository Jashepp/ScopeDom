
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

export class builtinLifecycle {
	
	/**
	 * $connect or $init attribute handler: run expression on element connection.
	 * 
	 * Compiles the expression into a connectCB and defers execution via timing based on options.
	 * :raf defers to RAF, :instant runs immediately, otherwise uses deferTask.
	 * 
	 * @param {HTMLElement} element The element being connected
	 * @param {scopeElementAttribDefaults} attrib The $connect attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 * @param {Array<Function>} onReadyQueue Queue for deferred onReady callbacks
	 * @param {string|null} [value] Expression value from the attribute
	 */
	static attrConnect(instance,element,attrib,elementScopeCtrl,options,onReadyQueue,value){
		if(value===null) value = instance.elementAttribFallbackOptionValue(attrib,['raf','instant']);
		let { attribute:$attribute } = attrib;
		let raf = options.get('raf'), instant = options.get('instant');
		if(value?.length>0){
			let { runFn:connectCB } = instance.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute },{ __proto__:null, run:false });
			onReadyQueue.push(builtinLifecycle.attrConnect_onReady.bind(null,element,$attribute,raf,instant,connectCB));
		}
	}
	
	/**
	 * Execute connect expression with timing defer based on :raf/:instant options.
	 * 
	 * @param {HTMLElement} element The element
	 * @param {string} $attribute Original attribute name
	 * @param {ScopeDomAttribOption|null} raf :raf option value
	 * @param {ScopeDomAttribOption|null} instant :instant option value
	 * @param {Function} connectCB Compiled expression function
	 */
	static attrConnect_onReady(element,$attribute,raf,instant,connectCB){
		if(raf && !timing.isDuringRAF) timing.onceAnimation(element,$attribute,connectCB);
		else if(instant) connectCB();
		else timing.deferTask(connectCB);
	}
	
	/**
	 * $disconnect or $deinit attribute handler: run expression on element disconnection.
	 * 
	 * Compiles the expression into a disconnectCB and defers execution via timing based on options.
	 * :raf defers to RAF, :instant runs immediately, otherwise uses deferTask.
	 * 
	 * @param {HTMLElement} element The element being disconnected
	 * @param {scopeElementAttribDefaults} attrib The $disconnect attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 */
	static attrDisconnect(instance,element,attrib,elementScopeCtrl,options){
		let { value, attribute:$attribute } = attrib;
		if(value===null) value = instance.elementAttribFallbackOptionValue(attrib,['raf','instant']);
		let raf = options.get('raf'), instant = options.get('instant');
		if(value?.length>0){
			let { runFn:disconnectCB } = instance.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute },{ __proto__:null, run:false });
			if(raf && !timing.isDuringRAF) timing.requestAnimation(disconnectCB);
			else if(instant || timing.isDuringRAF) disconnectCB();
			else timing.deferTask(disconnectCB);
		}
	}
	
}
