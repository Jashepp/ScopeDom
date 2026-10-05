
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

export class attrSignal {
	
	/**
	 * $signal-name:watch or $signal-name:compute attribute handler.
	 * 
	 * For watch mode: creates a signalObserver that re-runs the watch expression when the signal changes.
	 * For compute mode: creates a computed signal that updates the named signal from a source expression.
	 * 
	 * @param {HTMLElement} element The element
	 * @param {scopeElementAttribDefaults} attrib The $signal attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 * @param {string} name2 The signal name (eg, 'obj.prop')
	 * @param {string|null} [value] Expression value
	 */
	static attrSignal(instance,element,attrib,elementScopeCtrl,options,name2,value){
		let signalCtrl = instance.scopeCtrl.signalCtrl;
		let { attribute:$attribute } = attrib, watchOpt = options.get('watch'), computeOpt = options.get('compute');
		// Watch Signal
		let watchValue = watchOpt?.value?.length>0 ? watchOpt.value : value;
		if(watchValue?.length>0 && !watchOpt.isDefault && (!computeOpt || computeOpt?.value!==watchValue)){
			let { signal, expFn } = instance.ensureExpressionSignal(element,name2);
			if(signal){
				let state = { __proto__:null, oldValue:void 0, signal };
				let extra = { __proto__:null, $attribute, get $value(){ return signal?.get(); }, get $oldValue(){ return state.oldValue; } };
				// watchFn does not need to be wrapped, we're only watching this one signal, not its dependencies
				let { runFn:watchFn } = instance.elementExecExp(elementScopeCtrl,watchValue,extra,{ __proto__:null, run:false });
				/** @see {signalInstance.subscribe} Using subscribe since that creates a focused observer */
				let obs = signal.subscribe(attrSignal.attrSignal_watchListener.bind(null,state,watchFn));
				instance.registerElementRelatedEvent(element,obs.clear.bind(obs));
			}
		}
		// Compute Signal
		if(computeOpt?.value?.length>0 && !computeOpt.isDefault){
			let { signal } = instance.ensureExpressionSignal(element,name2);
			if(signal){
				let { runFn:computeFn } = instance.elementExecExp(elementScopeCtrl,computeOpt.value,{ __proto__:null, $attribute },{ __proto__:null, run:false, useReturn:true });
				let [ _, obs, clear ] = signalCtrl.computeSignal(function attribSignalCompute(){ return resolveSignal(computeFn()); },{ pull:true, signal });
				instance.registerElementRelatedEvent(element,clear);
			}
		}
	}
	
	static attrSignal_watchListener(state,watchFn,obs,signal,oldValue,newValue){
		if(newValue===void 0 && oldValue===signal.getSilent()) return; // Ignore same-value changes
		state.oldValue = oldValue;
		watchFn();
	}
	
}
