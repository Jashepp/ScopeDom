
import {
	noopFn, noopAsyncFn, deferFn,
	animFrameHelper, regexMatchAll, regexExec, regexTest,
	elementNodeType, commentNodeType, textNodeType,
	getPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn,
	objectProto, nodeProto, elementProto, functionProto, functionAsyncProto, nativeProtos, nativeConstructors,
	isNative, scopeAllowed, defineWeakRef,
	isElementLoaded, setAttribute, eventRegistry,
} from "./utils.js";
import {
	execExpression, execExpressionProxy,
} from "./exec.js";
import {
	signalController, signalObserver, signalProxy, signalInstance, resolveSignal,
} from "./signal.js";
import ScopeDom from "../scopedom.js";


export class scopeExpressionContext {};

export class scopeInstance {
	constructor(scopeObj,scopeCtrl){
		let mainObj = this;
		// If scopeObj is a plain Object, change proto to scopeBase
		if(getPrototypeOf(scopeObj)===objectProto){
			Object.setPrototypeOf(scopeObj,new scopeBase());
			mainObj = scopeObj;
		}
		// If scopeObj is something ele, change this scopeInstance proto to the scopeObj
		else Object.setPrototypeOf(this,scopeObj);
		// Add methods
		Object.defineProperties(mainObj,{
			$scopeTop:{ __proto__:null, configurable:false, enumerable:!true, get(){ return scopeCtrl?.topCtrl?.scope||scopeCtrl?.parentCtrl?.topCtrl?.scope||scopeCtrl?.parentCtrl?.scope||scopeCtrl?.scope; } },
			$scopeParent:{ __proto__:null, configurable:false, enumerable:!true, get(){ return scopeCtrl?.parentCtrl?.scope||scopeCtrl?.scope; } },
		});
		// Return this, or scopeObj if proto changed
		return mainObj;
	}
};

export class scopeBase {
	constructor(){ return Object.create(null,{
		__proto__: { __proto__:null, value:null },
		$scope:{ __proto__:null, configurable:false, enumerable:!true, get(){ return this; } }
	}); }
}

const scSymb = Symbol('$scopeControllerContext');
export class scopeControllerContext {
	constructor(scopeCtrl){ this[scSymb]=scopeCtrl; }
	get $scope(){ return this[scSymb].scope; };
	$update(suffix=''){ return this[scSymb].$emitScopeUpdate(suffix); };
	$off(name=null,listener=null,options=null){ return this[scSymb].$off(name,listener,options); };
	$on(name,listener,options={},returnRemove=false){ return this[scSymb].$on(name,listener,options,returnRemove); };
	$once(name,listener,options={},returnRemove=false){ return this[scSymb].$once(name,listener,options,returnRemove); };
	$emit(name,detail=null,options=null){ return this[scSymb].$emit(name,detail,options); };
	$emitRAF(name,detail=null,options=null,uniqueID=this.$attribute||'$emitRAF:scc'){ return animFrameHelper.onceRAF(this.$this||this[scSymb].scope,uniqueID+':'+name,()=>this[scSymb].$emit(name,detail,options)); };
	$onRAF(cb){ return animFrameHelper.requestAF(cb); };
	$onceRAF(cb,uniqueID=this.$attribute||'$onceRAF:scc'){ return animFrameHelper.onceRAF(this.$this||this[scSymb].scope,uniqueID,cb); };
	$offTarget(target,name=null,listener=null,options=null){ return this[scSymb].$offTarget(target,name,listener,options); };
	$onTarget(target,name,listener,options={},returnRemove=false){ return this[scSymb].$onTarget(target,name,listener,options,returnRemove); };
	$onceTarget(target,name,listener,options={},returnRemove=false){ return this[scSymb].$onceTarget(target,name,listener,options,returnRemove); };
	$emitTarget(target,name,detail=null,options=null){ return this[scSymb].$emitTarget(target,name,detail,options); };
	$signal(value=void 0){ return this[scSymb].$createSignal(value); } // signalInstance
}

export class scopeController {
	
	/**
	 * @constructor
	 * @param {scopeBase|object|null} scopeObj
	 * @param {EventTarget|null} eventTarget
	 * @param {scopeController|scopeElementController|null} parentCtrl
	 * @param {boolean} isolated
	 * @param {ScopeDom|null} ScopeDomInstance
	 */
	constructor(scopeObj=new scopeBase(),eventTarget=null,parentCtrl=null,isolated=false,ScopeDomInstance=null){
		if(scopeObj!==Object(scopeObj)) throw new Error("Missing scope object");
		if(parentCtrl instanceof scopeElementController) parentCtrl = parentCtrl.ctrl;
		this.ScopeDomInstance = ScopeDomInstance || parentCtrl?.ScopeDomInstance || null;
		this.eventRegistry = new eventRegistry();
		this.eventTarget = (eventTarget && eventTarget instanceof EventTarget) ? eventTarget : new EventTarget();
		this.verbose = false;
		this.topCtrl = parentCtrl?.topCtrl || null;
		this.parentCtrl = parentCtrl || null;
		this.isolated = isolated;
		/** @type {scopeInstance} */
		this.scope = new scopeInstance(scopeObj,this);
		/** @type {scopeControllerContext} */
		this.execContext = new scopeControllerContext(this);
		this.isDuringUpdate = false;
		/** @type {signalController} */
		this.signalCtrl = ScopeDomInstance?.scopeCtrl?.signalCtrl || parentCtrl?.signalCtrl || new signalController(this);
	}
	
	$emitScopeUpdate(suffix=''){
		let evt='$update'+(suffix?.length>0?'-'+suffix:''), emitUpdate=()=>{
			if(this.isDuringUpdate) return;
			this.isDuringUpdate = true;
			this.$emit(evt+':before'); this.$emit(evt); this.$emit(evt+':after');
			this.isDuringUpdate = false;
		};
		if(animFrameHelper.isDuringRAF || this.ScopeDomInstance.isDuringOnReady || this.isDuringUpdate){ deferFn(emitUpdate); }
		else animFrameHelper.onceRAF(this.scope,evt,emitUpdate,true);
	}
	
	$removeEvent(name=null,listener=null,options=null){
		return this.eventRegistry.remove(this.eventTarget,name,listener,options);
	}
	
	$off(name=null,listener=null,options=null){
		return this.$removeEvent(name,listener,options);
	}
	
	$on(name,listener,options={},returnRemove=false){
		options = { __proto__:null, capture:true, passive:false, ...options };
		this.eventRegistry.add(this.eventTarget,name,listener,options);
		if(returnRemove) return this.eventRegistry.remove.bind(this.eventRegistry,this.eventTarget,name,listener,options);
	}
	
	$once(name,listener,options={},returnRemove=false){
		options = { __proto__:null, capture:true, passive:false, once:true, ...options };
		return this.$on(name,listener,options,returnRemove);
	}
	
	$emit(name,detail=null,options=null){
		options = { __proto__:null, detail:detail, bubbles:false, cancelable:false, composed:true, ...options };
		return this.eventTarget.dispatchEvent(new CustomEvent(name,options));
	}
	
	$offTarget(target,name=null,listener=null,options=null){
		return this.eventRegistry.remove(target,name,listener,options);
	}
	
	$onTarget(target,name,listener,options={},returnRemove=false){
		options = { __proto__:null, capture:true, passive:false, ...options };
		this.eventRegistry.add(target,name,listener,options);
		if(returnRemove) return this.eventRegistry.remove.bind(this.eventRegistry,target,name,listener,options);
	}
	
	$onceTarget(target,name,listener,options={},returnRemove=false){
		options = { __proto__:null, capture:true, passive:false, once:true, ...options };
		return this.$onTarget(target,name,listener,options,returnRemove);
	}
	
	$emitTarget(target,name,detail=null,options=null){
		options = { __proto__:null, detail:detail, bubbles:false, cancelable:false, composed:true, ...options };
		return target.dispatchEvent(new CustomEvent(name,options));
	}
	
	/**
	 * Create new signal instance & record it immediately to any recording signal observers
	 * @param {any=} value
	 * @returns {Array<Function,Function,signalInstance>} [getter,setter,signalInstance]
	 */
	$signal(value=void 0){ let s=this.signalCtrl.createSignal(value); return [s.get.bind(s),s.set.bind(s),s]; }
	
	/** @type {typeof signalController.prototype.createSignal} */
	$createSignal(value=void 0,useWeakRef=false){ return this.signalCtrl.createSignal(value,useWeakRef); }
	
	/** @type {typeof signalController.prototype.defineSignal} */
	$defineSignal(obj,prop,value=void 0,descriptor=null,useOriginal=true){ return this.signalCtrl.defineSignal(obj,prop,value,descriptor,useOriginal); }
	
	/** @type {typeof signalController.prototype.assignSignals} */
	$assignSignals(target,source){ return this.signalCtrl.assignSignals(target,source); } // target
	
	/** @type {typeof signalController.prototype.computeSignal} */
	$computeSignal(fn,options={}){ return this.signalCtrl.computeSignal(fn,options); } // [ signal, observer, clear() ]
	
	/** @type {typeof signalController.prototype.proxySignal} */
	$proxySignal(value){ return this.signalCtrl.proxySignal(value); } // proxy
	
	/** @type {typeof signalController.prototype.defineProxySignal} */
	$defineProxySignal(obj,prop,value){ return this.signalCtrl.defineProxySignal(obj,prop,value); } // proxy
	
	/** @type {typeof signalController.prototype.preventUpdates} */
	$preventSignalUpdates(value,...args){ return this.signalCtrl.preventUpdates(fn,...args); }
	
	/** @type {typeof signalController.prototype.preventObservers} */
	$preventSignalObservers(value,...args){ return this.signalCtrl.preventObservers(fn,...args); }
	
}

const seSymb = Symbol('$scopeElementContext');
/** @class scopeElementContext */
export class scopeElementContext {
	
	/** @param {scopeElementController} eScopeCtrl */
	constructor(eScopeCtrl){ this[seSymb]=eScopeCtrl; }
	
	/** @type {HTMLElement} */
	get $this(){ return this[seSymb].element; };
	
	/** @type {HTMLElement} */
	get $parent(){ return (this[seSymb].element.parentNode instanceof ShadowRoot && this[seSymb].element.parentNode.host) ? this[seSymb].element.parentNode.host : this[seSymb].element.parentNode; };
	
	/** @type {HTMLElement} */
	get $previous(){ return this[seSymb].element.previousElementSibling; };
	
	/** @type {HTMLElement} */
	get $next(){ return this[seSymb].element.nextElementSibling; };
	
	/** @type {Document} */
	get document(){ return this[seSymb].element.ownerDocument; };
	
	/** @type {typeof HTMLElement.prototype.ownerDocument.querySelector} */
	$(query){ return this[seSymb].element.ownerDocument.querySelector(query); };
	
	/** @type {typeof HTMLElement.prototype.querySelector} */
	$$(query){ return this[seSymb].element.querySelector(query); };
	
	/** @type {typeof scopeElementController.prototype.$offDom} */
	$offDom(name=null,listener=null,options=null){ return this[seSymb].$offDom(name,listener,options); };
	
	/** @type {typeof scopeElementController.prototype.$onDom} */
	$onDom(name,listener,options={},returnRemove=false){ return this[seSymb].$onDom(name,listener,options,returnRemove); };
	
	/** @type {typeof scopeElementController.prototype.$onceDom} */
	$onceDom(name,listener,options={},returnRemove=false){ return this[seSymb].$onceDom(name,listener,options,returnRemove); };
	
	/** @type {typeof scopeElementController.prototype.$emitDom} */
	$emitDom(name,detail=null,options=null){ return this[seSymb].$emitDom(name,detail,options); };
	
	/**
	 * @param {string} name
	 * @param {object} detail
	 * @param {object} options
	 * @param {string} uniqueID
	 */
	$emitDomRAF(name,detail=null,options=null,uniqueID=this.$attribute||'$emitDomRAF:sec'){ return animFrameHelper.onceRAF(this[seSymb].element,uniqueID+':'+name,()=>this[seSymb].$emitDom(name,detail,options)); };
	
}

/** @class scopeElementController */
export class scopeElementController {
	
	/**
	 * @constructor
	 * @param {HTMLElement} element
	 * @param {scopeBase|object|null|undefined} scopeObj
	 * @param {scopeController|scopeElementController|null|undefined} scopeCtrl
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
	
	// extraScopes [{},...] elementScopes: [[element,scopesArr],...]
	/**
	 * @param {string} expression 
	 * @param {Array<object>|null} extraScopes 
	 * @param {Array<object>|null} elementScopes 
	 * @param {execExp.execExpOptions|object|null} fnOptions
	 * @returns 
	 */
	execElementExpression(expression,extraScopes=null,elementScopes=null,fnOptions=null){
		fnOptions = { __proto__:null, ...fnOptions, scopeCtrl:this.ctrl };
		let elementContext = !fnOptions?.hideDocument ? this.execContext : null;
		if(!hasOwn(fnOptions,'fnThis') && !fnOptions?.hideDocument) fnOptions.fnThis = this.element;
		let instance = this.ctrl.ScopeDomInstance;
		// Main controller scopes
		let mainScopes = [];
		for(let c=this.ctrl; c; c=c.parentCtrl){
			mainScopes.push(c.scope);
			if(c.isolated) break;
		}
		let scopeUseOwn = new WeakSet();
		// Proto list of mainScopes, to not be in otherScopes
		let msProtoList = new Set();
		for(let ms of mainScopes) for(let o=ms; o && scopeAllowed(o); o=getPrototypeOf(o)) msProtoList.add(o);
		// Other scopes
		let otherScopes = new Set();
		// Add extraScopes & it's prototypes
		if(extraScopes?.length>0){
			for(let s of extraScopes) for(let o=s; o && scopeAllowed(o); o=getPrototypeOf(o)){
				if(!msProtoList.has(o) && !otherScopes.has(o)){
					otherScopes.add(o);
					scopeUseOwn.add(o);
				}
			}
		}
		// Add elementScopes & it's prototypes
		if(elementScopes?.length>0) for(let [e,sArr] of elementScopes) for(let s of sArr){
			// Add element scopes
			for(let o=s; o && scopeAllowed(o); o=getPrototypeOf(o)){
				if(!msProtoList.has(o) && !otherScopes.has(o)){
					otherScopes.add(o);
					scopeUseOwn.add(o);
				}
			}
			// Add element controller scopes
			let eScopeCtrl = instance?.cacheElementScopeCtrls.get(e);
			if(eScopeCtrl){
				for(let o=eScopeCtrl.scope; o && scopeAllowed(o); o=getPrototypeOf(o)){
					if(!msProtoList.has(o) && !otherScopes.has(o)){
						otherScopes.add(o);
						scopeUseOwn.add(o);
					}
				}
			}
		}
		// Add current element controller context
		if(elementContext) otherScopes.add(elementContext);
		// Add current scope controller context
		if(this.ctrl.execContext) otherScopes.add(this.ctrl.execContext);
		// Run or build execExpression
		fnOptions.scopeUseOwn = scopeUseOwn;
		if(fnOptions.run!==false) return execExpression.runExp(expression,mainScopes,otherScopes,fnOptions);
		else return execExpression.buildExp(expression,mainScopes,otherScopes,fnOptions);
	}
	
	// Only called by plugins - not yet used
	$emitDomUpdate(suffix='',emitSelf=false){
		if(this.isDuringUpdateDom) return; // Ignore DOM Update during DOM Update (for same element)
		if(this.ctrl.isDuringUpdate) return; // Ignore DOM Update during Scope Update
		if(this.ScopeDomInstance.isDuringOnReady) return; // Ignore DOM Update during On Ready
		let evt='$update'+(suffix?.length>0?'-'+suffix:''), u=void 0, emitUpdate=()=>{
			if(this.isDuringUpdateDom) return;
			this.isDuringUpdateDom = true;
			this.$emitDomChildren(evt+':before',u,u,emitSelf); this.$emitDomChildren(evt,u,u,emitSelf); this.$emitDomChildren(evt+':after',u,u,emitSelf);
			this.isDuringUpdateDom = false;
		};
		if(animFrameHelper.isDuringRAF){ deferFn(emitUpdate); }
		else animFrameHelper.onceRAF(this.element,evt,emitUpdate,true);
	}
	
	$emitDomChildren(name,detail=null,options=null,emitSelf=false){
		options = { __proto__:null, ...options, bubbles:false };
		let emitChildren = (e,emitSelf=false)=>{
			if(emitSelf) this.ctrl.$emitTarget(e,name,detail,options);
			if(e?.childNodes?.length>0) for(let c of [...e.childNodes]) if(c.isConnected && c.parentNode===e) emitChildren(c,true);
		};
		emitChildren(this.element,emitSelf);
	}
	
	/**
	 * @param {string} name
	 * @param {Function} listener
	 * @param {object} options
	 */
	$offDom(name=null,listener=null,options=null){
		return this.ctrl.$offTarget(this.element,name,listener,options);
	}
	
	/**
	 * @param {string} name
	 * @param {Function} listener
	 * @param {object} options
	 * @param {boolean} returnRemove
	 */
	$onDom(name,listener,options={},returnRemove=false){
		return this.ctrl.$onTarget(this.element,name,listener,options,returnRemove);
	}
	
	/**
	 * @param {string} name
	 * @param {Function} listener
	 * @param {object} options
	 * @param {boolean} returnRemove
	 */
	$onceDom(name,listener,options={},returnRemove=false){
		return this.ctrl.$onceTarget(this.element,name,listener,options,returnRemove);
	}
	
	/**
	 * @param {string} name
	 * @param {object} detail
	 * @param {object} options
	 */
	$emitDom(name,detail=null,options=null){
		return this.ctrl.$emitTarget(this.element,name,detail,options);
	}
	
}
