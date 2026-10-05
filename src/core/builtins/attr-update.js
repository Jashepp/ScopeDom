
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

export class attrUpdate {
	
	/**
	 * $update or $update-name attribute handler: run expression on scope update events.
	 * 
	 * If a name suffix is present (eg, $update-customword), the expression runs on
	 * $update('customword') events. If $update:before or $update:after options are set,
	 * they determine whether the event is dispatched before or after the main update.
	 * 
	 * @private
	 * @param {HTMLElement} element The element
	 * @param {scopeElementAttribDefaults} attrib The $update attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 */
	static attrUpdate(instance,element,attrib,elementScopeCtrl,options){
		let [ name, name2 ] = attrib.nameParts;
		let beforeOpt = options.get('before'), afterOpt = options.get('after');
		for(let type of ['before','','after']){
			let expValue = null, attrName = null;
			if(beforeOpt && type==='before'){ expValue = beforeOpt.value; attrName = beforeOpt.attribute; }
			else if(afterOpt && type==='after'){ expValue = afterOpt.value; attrName = afterOpt.attribute; }
			else if(type===''){ expValue = attrib.value; attrName = attrib.attribute; }
			else continue;
			if(expValue===null || expValue?.length===0) continue;
			// Setup $update listener
			let { runFn:updateCB } = instance.elementExecExp(elementScopeCtrl,expValue,{ __proto__:null, $attribute:attrName },{ __proto__:null, run:false });
			// Register events straight away
			let evt = '$update'+(name2?.length>0?'-'+name2:'')+(type!==''?':'+type:'');
			let removeListener = elementScopeCtrl.ctrl.$on(evt,updateCB,{},true);
			instance.registerElementRelatedEvent(element,removeListener);
		}
	}
	
}
