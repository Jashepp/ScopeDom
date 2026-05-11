
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
import {
	scopeInstance, scopeBase, scopeControllerContext, scopeController
} from "./core.js";
import ScopeDom from "../../scopedom.js";
import { scopeExpression } from "./expression.js";


const seSymb = Symbol('$scopeElementContext');

/**
 * Expression context class for scope element controller operations.
 * Provides access to scope element controller methods and properties in expressions.
 * 
 * This class exposes DOM-related capabilities including:
 * - Element references ($this, $parent, $previous, $next)
 * - Document access (document)
 * - Query selectors ($(query), $$(query))
 * - DOM event handling ($offDom, $onDom, $onceDom, $emitDom, $emitDomRAF)
 * 
 * @class scopeElementContext
 */
export class scopeElementContext {
	
	/**
	 * @constructor
	 * @param {scopeElementController} eScopeCtrl
	 */
	constructor(eScopeCtrl){ this[seSymb]=eScopeCtrl; }
	
	/**
	 * Get this element.
	 * 
	 * @type {HTMLElement}
	 */
	get $this(){ return this[seSymb].element; };
	
	/**
	 * Get the parent element (or host if in Shadow DOM).
	 * 
	 * @type {HTMLElement}
	 */
	get $parent(){ return (this[seSymb].element.parentNode instanceof ShadowRoot && this[seSymb].element.parentNode.host) ? this[seSymb].element.parentNode.host : this[seSymb].element.parentNode; };
	
	/**
	 * Get the previous sibling element.
	 * 
	 * @type {HTMLElement}
	 */
	get $previous(){ return this[seSymb].element.previousElementSibling; };
	
	/**
	 * Get the next sibling element.
	 * 
	 * @type {HTMLElement}
	 */
	get $next(){ return this[seSymb].element.nextElementSibling; };
	
	/**
	 * Get the document this element belongs to.
	 * 
	 * @type {Document}
	 */
	get document(){ return this[seSymb].element.ownerDocument; };
	
	/**
	 * Query selector on the document.
	 * @param {string} query CSS selector
	 * @returns {HTMLElement|null} The matched element
	 */
	$(query){ return this[seSymb].element.ownerDocument.querySelector(query); };
	
	/**
	 * Query selector on the element.
	 * 
	 * @param {string} query CSS selector
	 * @returns {HTMLElement|null} The matched element
	 */
	$$(query){ return this[seSymb].element.querySelector(query); };
	
	/**
	 * Remove a DOM event listener for this element.
	 * 
	 * @param {string} [name=null] Event name
	 * @param {Function} [listener=null] Event listener function
	 * @param {object} [options=null] Event options
	 * @returns {boolean} Result of removal
	 */
	$offDom(name=null,listener=null,options=null){ return this[seSymb].$offDom(name,listener,options); };
	
	/**
	 * Add a DOM event listener for this element.
	 * 
	 * @param {string} name Event name
	 * @param {Function} listener Event listener function
	 * @param {object} [options] Event options (capture, passive, once)
	 * @param {boolean} [returnRemove=false] Return remove function
	 * @returns {Function|undefined} Remove function if returnRemove is true
	 */
	$onDom(name,listener,options={},returnRemove=false){ return this[seSymb].$onDom(name,listener,options,returnRemove); };
	
	/**
	 * Add a one-time DOM event listener for this element.
	 * 
	 * @param {string} name Event name
	 * @param {Function} listener Event listener function
	 * @param {object} [options] Event options (capture, passive, once)
	 * @param {boolean} [returnRemove=false] Return remove function
	 * @returns {Function|undefined} Remove function if returnRemove is true
	 */
	$onceDom(name,listener,options={},returnRemove=false){ return this[seSymb].$onceDom(name,listener,options,returnRemove); };
	
	/**
	 * Emit a DOM event for this element.
	 * 
	 * @param {string} name Event name
	 * @param {object} [detail=null] Event detail
	 * @param {object} [options=null] Event options (detail, bubbles, cancelable, composed)
	 * @returns {boolean} Result of dispatch
	 */
	$emitDom(name,detail=null,options=null){ return this[seSymb].$emitDom(name,detail,options); };
	
	/**
	 * Emit a DOM event on RAF (request animation frame) for this element.
	 * 
	 * This uses timing.onceAnimation() to deduplicate events by uniqueID, preventing multiple rapid emissions.
	 * 
	 * @param {string} name Event name
	 * @param {object} [detail=null] Event detail
	 * @param {object} [options=null] Event options
	 * @param {string} [uniqueID] Unique ID for onceRAF deduplication (default as $attribute or '$emitDomRAF:sec')
	 */
	$emitDomRAF(name,detail=null,options=null,uniqueID=this.$attribute||'$emitDomRAF:sec'){ return timing.onceAnimation(this[seSymb].element,uniqueID+':'+name,()=>this[seSymb].$emitDom(name,detail,options)); };
	
}

/** @class scopeElementController */
export class scopeElementController {
	
	/**
	 * @constructor
	 * @param {HTMLElement} element The element
	 * @param {scopeBase|object|null|undefined} [scopeObj] Scope base object
	 * @param {scopeController|scopeElementController|null|undefined} [scopeCtrl] The scopeController
	 */
	constructor(element,scopeObj=void 0,scopeCtrl=void 0){
		if(!element) throw new Error("Missing element?");
		if(scopeCtrl instanceof scopeElementController) scopeCtrl = scopeCtrl.ctrl;
		/** @type {typeof HTMLElement} */
		this.element = element;
		/** @type {typeof scopeController} */
		this.ctrl = !scopeObj && scopeCtrl ? scopeCtrl : new scopeController(scopeObj,scopeCtrl?.eventTarget,scopeCtrl);
		/** @type {typeof scopeInstance} */
		this.scope = this.ctrl.scope;
		/** @type {typeof eventRegistry} */
		this.eventRegistry = this.ctrl.eventRegistry;
		/** @type {typeof scopeElementContext} */
		this.execContext = new scopeElementContext(this);
		this.isDuringUpdateDom = false;
	}
	
	/**
	 * Execute an expression on the element with a list of scopes for context.
	 * 
	 * This method walks up the controller hierarchy to collect mainScopes, then collects
	 * additional scopes from extraScopes and elementScopes while avoiding duplicates.
	 * Then it either runs the expression immediately (run=true) or builds it for later execution (run=false).
	 * 
	 * @param {string} expression The expression to execute
	 * @param {Array<object>|null} [extraScopes=null] Extra scopes to include [{},...]
	 * @param {Array<object>|null} [elementScopes=null] Element scopes to include [[element,scopesArr],...]
	 * @param {execExp.execExpOptions|object|null} [fnOptions=null] Execution options (run:true/false)
	 * @returns {any} execExpression result object
	 */
	execElementExpression(expression,extraScopes=null,elementScopes=null,fnOptions=null){
		return scopeExpression.prepareExpression(this,expression,extraScopes,elementScopes,fnOptions);
	}
	
	/**
	 * Emit DOM update event for this element.
	 * 
	 * Only called by plugins - not yet used.
	 * 
	 * @param {string} [suffix] Optional suffix for custom update events
	 * @param {boolean} [emitSelf=false] emit event on own element+children, or only children
	 */
	$emitDomUpdate(suffix='',emitSelf=false){
		if(this.isDuringUpdateDom) return; // Ignore DOM Update during DOM Update (for same element)
		if(this.ctrl.isDuringUpdate) return; // Ignore DOM Update during Scope Update
		if(this.ScopeDomInstance.isDuringOnReady) return; // Ignore DOM Update during On Ready
		let evt = '$update'+(suffix?.length>0?'-'+suffix:'');
		let emitUpdate = this.#emitUpdate.bind(this,evt,void 0,emitSelf);
		if(timing.isDuringRAF){ timing.deferTask(emitUpdate); }
		else timing.onceAnimation(this.element,evt,emitUpdate,true);
	}
	
	#emitUpdate(evt,u,emitSelf){
		if(this.isDuringUpdateDom) return; // Ignore DOM Update during DOM Update (for same element)
		this.isDuringUpdateDom = true;
		this.$emitDomChildren(evt+':before',u,u,emitSelf);
		this.$emitDomChildren(evt,u,u,emitSelf);
		this.$emitDomChildren(evt+':after',u,u,emitSelf);
		this.isDuringUpdateDom = false;
	}
	
	/**
	 * Emit DOM update event to children.
	 * 
	 * Only called by plugins - not yet used.
	 * 
	 * @param {string} name Event name
	 * @param {object} [detail=null] Event detail
	 * @param {object} [options=null] Event options
	 * @param {boolean} [emitSelf=false] emit event on own element+children, or only children
	 */
	$emitDomChildren(name,detail=null,options=null,emitSelf=false){
		options = { __proto__:null, ...options, bubbles:false };
		this.#emitChildren(this.element,emitSelf,name,detail,options);
	}
	
	#emitChildren(e,emitSelf,name,detail,options){
		if(emitSelf) this.ctrl.$emitTarget(e,name,detail,options);
		if(e?.childNodes?.length>0) for(let c of Array.from(e.childNodes)){
			if(c.isConnected && c.parentNode===e) this.#emitChildren(c,true,name,detail,options);
		}
	}
	
	/**
	 * Remove a registered DOM event listener for this element.
	 * 
	 * @param {string} [name=null] Event name
	 * @param {Function} [listener=null] Event listener function
	 * @param {object} [options=null] Event options
	 * @returns {boolean} Result of removal
	 */
	$offDom(name=null,listener=null,options=null){
		return this.ctrl.$offTarget(this.element,name,listener,options);
	}
	
	/**
	 * Add a DOM event listener for this element.
	 * 
	 * @param {string} name Event name
	 * @param {Function} listener Event listener function
	 * @param {object} [options] Event options (capture, passive, once)
	 * @param {boolean} [returnRemove=false] Return remove function
	 * @returns {Function|undefined} Remove function if returnRemove is true
	 */
	$onDom(name,listener,options={},returnRemove=false){
		return this.ctrl.$onTarget(this.element,name,listener,options,returnRemove);
	}
	
	/**
	 * Add a one-time DOM event listener for this element.
	 * 
	 * @param {string} name Event name
	 * @param {Function} listener Event listener function
	 * @param {object} [options] Event options (capture, passive, once)
	 * @param {boolean} [returnRemove=false] Return remove function
	 * @returns {Function|undefined} Remove function if returnRemove is true
	 */
	$onceDom(name,listener,options={},returnRemove=false){
		return this.ctrl.$onceTarget(this.element,name,listener,options,returnRemove);
	}
	
	/**
	 * Emit a DOM event for this element.
	 * 
	 * @param {string} name Event name
	 * @param {object} [detail=null] Event detail
	 * @param {object} [options=null] Event options (detail, bubbles, cancelable, composed)
	 * @returns {boolean} Result of dispatch
	 */
	$emitDom(name,detail=null,options=null){
		return this.ctrl.$emitTarget(this.element,name,detail,options);
	}
	
}
