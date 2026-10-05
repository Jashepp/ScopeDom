
import {
	noopFn,noopAsyncFn,setUnion,disposeSymbol,isPromise,
	microtaskCache,mtCacheGetDefinedProperty,mtCacheDefineProperty,mtCacheGetPrototypeOf,mtCacheSetPrototypeOf,
	regexMatchAll,regexExec,regexTest,regexMatchAllFirstGroup,
	elementNodeType,commentNodeType,textNodeType,
	getPrototypeOf,getOwnPropertyDescriptor,defineProperty,hasOwn,
	objectProto,nodeProto,elementProto,functionProto,functionAsyncProto,nativeProtos,nativeConstructors,
	isNative,scopeAllowed,defineWeakRef,
	setAttribute,eventRegistry,
} from "./utils.js";
import {
	timing,
} from "./timing.js";
import {
	execExpression,execExpressionProxy,
} from "./exec.js";
import {
	signalController, signalObserver, signalProxy, signalInstance, resolveSignal, signalSymb,
} from "./signal.js";
import ScopeDom from "../scopedom.js";

import { attrClass } from "./builtins/attr-class.js";
import { attrScope } from "./builtins/attr-scope.js";
import { attrSignal } from "./builtins/attr-signal.js";
import { attrStyle } from "./builtins/attr-style.js";
import { attrSwap } from "./builtins/attr-swap.js";
import { attrUpdate } from "./builtins/attr-update.js";
import { builtinEvents } from "./builtins/events.js";
import { builtinLifecycle } from "./builtins/lifecycle.js";

/**
 * Built-in Attributes - central handler for ScopeDom's core reactive attribute features.
 * 
 * The builtinAttributes class is a plugin handler that processes ScopeDom's built-in
 * attributes by dispatching to the appropriate handlers on element connect/disconnect.
 * It is the primary mechanism through which ScopeDom's attribute system (as opposed to
 * the signal system) makes DOM updates reactive.
 * 
 * Supported attributes:
 * - $swap - Element/Template replacement with template contents
 * - $scope / $scope-name - Create new scopes (with optional $scope:isolate)
 * - $connect / $init - Execute expression on element connection (supports :raf, :instant)
 * - $disconnect / $deinit - Execute expression on element disconnection (supports :raf, :instant)
 * - $update / $update-name - Execute expression on ScopeDom update events (before/after)
 * - $class - Class list management via Expression (Array/Set/Map/Object)
 * - $signal-name:watch - Watch signal changes and execute expression
 * - $signal-name:compute - Compute and update signal value from expression
 * - $on-* / $once-* - DOM event listeners from expressions
 * 
 * @class builtinAttributes
 */
export class builtinAttributes {
	
	instance = null;
	
	/**
	 * Built-in attributes handler constructor.
	 * 
	 * Stores a reference to the ScopeDom instance for use by all attribute handlers during
	 * element connect/disconnect processing.
	 * 
	 * @constructor
	 * @param {ScopeDom} instance The ScopeDom instance this handler is bound to
	 */
	constructor(instance){
		this.instance = instance;
	}
	
	/**
	 * Handle element onConnect for built-in attributes.
	 * 
	 * Dispatches to specialized handler methods based on attribute name parts.
	 * Returns false when $swap is processed (preventing further attribute or plugin processing).
	 * 
	 * @param {HTMLElement} element The element being connected
	 * @param {Map<string,scopeElementAttribDefaults>} attribs Parsed ScopeDom attributes Map
	 * @param {scopeElementController} elementScopeCtrl The scope element controller for the element
	 * @returns {boolean|undefined} false if $swap was processed (skip further attributes/plugins); undefined otherwise
	 */
	onConnect(element,attribs,elementScopeCtrl){
		let instance = this.instance, onReadyQueue = [];
		// Swap
		if(element.nodeName==='TEMPLATE' && attribs.has('swap')){
			attrSwap.attrSwap(instance,element,attribs);
			return false; // Exit early, don't process other attributes or plugins
		}
		// Scope
		let scopeAttrib = attribs.get('scope'), scopeNamedAttrib = attribs.get('scope name');
		if(scopeAttrib || scopeNamedAttrib){
			attrScope.attrScope(instance,element,elementScopeCtrl,scopeAttrib,scopeNamedAttrib);
		}
		// Other built-in attribs
		for(let [attribName,attrib] of attribs){
			let { nameParts, value } = attrib;
			let [ name, name2 ] = nameParts;
			if(name==='default') continue;
			let options = instance.elementAttribOptionsWithDefaults(element,attrib);
			// Init / Connect
			if(nameParts.length===1 && (name==='init' || name==='connect')){
				builtinLifecycle.attrConnect(instance,element,attrib,elementScopeCtrl,options,onReadyQueue,value);
				continue;
			}
			// Listen for Update Scope
			if((nameParts.length===1 || nameParts.length===2) && name==='update'){
				attrUpdate.attrUpdate(instance,element,attrib,elementScopeCtrl,options);
				continue;
			}
			// Class Attribute
			if(nameParts.length===1 && name==='class' && value!==null){
				attrClass.attrClass(instance,element,attrib,elementScopeCtrl,options,value,onReadyQueue);
				continue;
			}
			// Style Attribute
			if(nameParts.length===1 && name==='style' && value!==null){
				attrStyle.attrStyle(instance,element,attrib,elementScopeCtrl,options,value,onReadyQueue);
				continue;
			}
			// Signal Attribute (lowercase keys)
			if(nameParts.length===2 && name==='signal' && name2?.length>0){
				attrSignal.attrSignal(instance,element,attrib,elementScopeCtrl,options,name2,value);
				continue;
			}
			// Events
			if(nameParts.length===2){
				let [ type, eventName ] = nameParts;
				if(type==='on'){ nameParts = [ type,'dom',eventName ]; }
				else if(type==='once'){ nameParts = [ type,'dom',eventName ]; }
			}
			if(nameParts.length===3 && (nameParts[0]==='on' || nameParts[0]==='once')){
				let [ type, target, eventName ] = nameParts;
				builtinEvents.attrEvent(instance,element,attrib,elementScopeCtrl,options,type,target,eventName,value);
				continue;
			}
		}
		// Handle onReady queue
		if(onReadyQueue.length>0) instance.onReady(this.#processOnConnectOnReadyQueue.bind(this,onReadyQueue),false);
	}
	
	/**
	 * Execute queued onConnect callbacks during the onReady lifecycle.
	 * 
	 * Called via instance.onReady() to run connect-related expressions for elements
	 * whose attributes required DOM readiness.
	 * 
	 * @param {Array<Function>} queue Queue for deferred callbacks
	 * @private
	 */
	#processOnConnectOnReadyQueue(queue){
		for(let cb of queue) cb.apply(this);
	}
	
	/**
	 * Handle element onDisconnect for built-in attributes.
	 * 
	 * Dispatches to #attrDisconnect for deinit/disconnect attributes only.
	 * 
	 * @param {HTMLElement} element The element being disconnected
	 * @param {Map<string,scopeElementAttribDefaults>} attribs Parsed ScopeDom attributes Map
	 * @param {scopeElementController} elementScopeCtrl The scope element controller for the element
	 */
	onDisconnect(element,attribs,elementScopeCtrl){
		let instance = this.instance;
		for(let [attribName,attrib] of attribs){
			let { nameParts, value } = attrib;
			let [ name ] = nameParts;
			if(name==='default') continue;
			let options = instance.elementAttribOptionsWithDefaults(element,attrib);
			// Handle deinit / disconnect attributes
			if(nameParts.length===1 && (name==='deinit' || name==='disconnect')){
				let options = instance.elementAttribOptionsWithDefaults(element,attrib);
				builtinLifecycle.attrDisconnect(instance,element,attrib,elementScopeCtrl,options);
				continue;
			}
			// Class Attribute
			if(nameParts.length===1 && name==='class' && attrib.value!==null){
				attrClass.attrClassUndo(instance,element,attrib,elementScopeCtrl,options);
				continue;
			}
			// Style Attribute
			if(nameParts.length===1 && name==='style' && attrib.value!==null){
				attrStyle.attrStyleUndo(instance,element,attrib,elementScopeCtrl,options);
				continue;
			}
		}
	}
	
}
