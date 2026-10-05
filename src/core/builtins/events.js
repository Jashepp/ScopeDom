
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

export class builtinEvents {
	
	/**
	 * $on-target-event or $once-target-event attribute handler.
	 * 
	 * Routes to the appropriate event method based on type (on/once) and target (dom/scope/window/document).
	 * The expression is compiled and executed with timing defer based on :raf/:instant options.
	 * The :pd option prevents default behavior.
	 * 
	 * @param {HTMLElement} element The element
	 * @param {scopeElementAttribDefaults} attrib The $on-* attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 * @param {string} type 'on' or 'once'
	 * @param {string} target Event target ('dom', 'scope', 'window', 'document')
	 * @param {string} eventName Event name (eg, 'click', 'keypress')
	 * @param {string|null} [value] Expression value
	 */
	static attrEvent(instance,element,attrib,elementScopeCtrl,options,type,target,eventName,value){
		let evtBase=null, evtMethod=null, evtTarget=null;
		if(type==='on' && target==='dom'){ evtBase = elementScopeCtrl; evtMethod = '$onDom'; }
		else if(type==='once' && target==='dom'){ evtBase = elementScopeCtrl; evtMethod = '$onceDom'; }
		else if(type==='on' && target==='scope'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$on'; }
		else if(type==='once' && target==='scope'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$once'; }
		else if(type==='on' && target==='window'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$onTarget'; evtTarget=window; }
		else if(type==='once' && target==='window'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$onceTarget'; evtTarget=window; }
		else if(type==='on' && target==='document'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$onTarget'; evtTarget=document; }
		else if(type==='once' && target==='document'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$onceTarget'; evtTarget=document; }
		if(evtBase && evtMethod){
			if(value===null) value = instance.elementAttribFallbackOptionValue(attrib,['raf','instant','pd']);
			let { attribute:$attribute } = attrib;
			let raf = options.get('raf'), instant = options.get('instant'), pd = options.get('pd');
			if(value?.length>0){
				let { runFn:eventCB, firstScope } = instance.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute },{ __proto__:null, run:false });
				let eventListener = builtinEvents.attrEvent_listener.bind(null,instance,element,raf,instant,pd,firstScope,eventCB,$attribute);
				// Register events straight away
				let removeListener = evtTarget ? evtBase[evtMethod](evtTarget,eventName,eventListener,{},true) : evtBase[evtMethod](eventName,eventListener,{},true);
				instance.registerElementRelatedEvent(element,removeListener);
			}
		}
	}
	
	/**
	 * Event listener callback for $on-* / $once-* attribute handlers.
	 * 
	 * Applies prevent-default if configured, injects the event into firstScope, then routes
	 * execution through timing.deferTask, timing.onceAnimation (RAF), or immediate execution
	 * based on configuration flags (raf, instant, pd).
	 * 
	 * @param {HTMLElement} element The source element
	 * @param {boolean} raf Whether to defer execution via requestAnimationFrame
	 * @param {boolean} instant Whether to execute immediately without defer
	 * @param {boolean} pd Whether to prevent the default event behavior
	 * @param {object} firstScope The first scope for $event injection
	 * @param {Function} eventCB The expression callback to execute
	 * @param {string} $attribute The attribute key string used for RAF dedup
	 * @param {Event} event The DOM event object
	 * @returns {boolean|void} False if preventDefault was applied, otherwise void
	 */
	static attrEvent_listener(instance,element,raf,instant,pd,firstScope,eventCB,$attribute,event){
		if(pd) event.preventDefault();
		firstScope.$event = event;
		if(timing.isDuringRAF || instance.isDuringOnReady) eventCB();
		else if(raf) timing.onceAnimation(element,$attribute,eventCB);
		else if(instant) eventCB();
		else timing.deferTask(eventCB);
		if(pd) return false;
	}
	
}
