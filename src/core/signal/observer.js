
import {
	noopFn, noopAsyncFn, deferFn,
	animFrameHelper, regexMatchAll, regexExec, regexTest,
	elementNodeType, commentNodeType, textNodeType,
	getPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn,
	objectProto, nodeProto, elementProto, functionProto, functionAsyncProto, nativeProtos, nativeConstructors,
	isNative, scopeAllowed, defineWeakRef,
	isElementLoaded, setAttribute, eventRegistry,
} from "../utils.js";
import {
	execExpression, execExpressionProxy,
} from "../exec.js";
import {
	scopeInstance, scopeBase, scopeControllerContext, scopeController, scopeElementContext, scopeElementController,
} from "../scope.js";

import { signalController } from "./controller.js";
import { signalInstance, signalSymb } from "./instance.js";
import { signalProxy, resolveSignal } from "./proxy.js";

export class signalObserver {
	
	constructor(signalCtrl,options={}){
		options = { __proto__:null, defer:signalCtrl?.ScopeDomInstance?.options?.signalDefer, ...options };
		this.ctrl = signalCtrl;
		this.signals = new WeakSet();
		this.signalsIgnore = new WeakSet();
		this.listeners = new Set();
		this.isRecording = false;
		this.isChanging = false;
		this.deferChange = options.defer===true || options.defer===void 0;
		this.isDeferring = false;
	}
	
	hasSignal(signal){ return this.signals.has(signal); }
	
	recordSignal(signal){
		if(!this.signals.has(signal) && !this.signalsIgnore.has(signal)) this.signals.add(signal);
	}
	
	triggerChange(signal,oldValue,newValue,forceDefer=false){
		if(this.isDeferring || this.isRecording) return;
		if(this.isChanging || !this.signals.has(signal)) forceDefer = true;
		let self=this;
		function signalObserverListener(fn){ fn(self,signal,oldValue,newValue); };
		function signalObserverTrigger(){
			self.isDeferring = false;
			if(self.isChanging || self.listeners.size===0) return;
			self.isChanging = true;
			for(let fn of self.listeners) try{ signalObserverListener(fn); } catch(err){ console.error(err); }
			self.isChanging = false;
		}
		if(!this.deferChange && !forceDefer) return signalObserverTrigger();
		this.isDeferring = true;
		deferFn(signalObserverTrigger);
	}
	
	startRecording(){
		if(this.isRecording) return false;
		this.isRecording = true;
		this.ctrl.startObserverRecording(this);
		return true;
	}
	
	stopRecording(){
		if(!this.isRecording) return false;
		this.isRecording = false;
		this.ctrl.stopObserverRecording(this);
		return true;
	}
	
	wrapRecorder(fn){
		let self = this;
		return function signalObserverRecorder(...args){
			let recording = self.startRecording();
			let result; try{ result=fn(...args); }catch(err){ console.error(err); }
			if(recording) self.stopRecording();
			return result;
		};
	}
	
	addListener(fn){ this.listeners.add(fn); return this.removeListener.bind(this,fn); }
	
	removeListener(fn){ this.listeners.delete(fn); }
	
	clear(){ this.listeners.clear(); this.signals=new WeakSet(); this.ctrl.removeObserver(this,false); }
	
	clearSignals(){ this.signals=new WeakSet(); }
}

if(Symbol.dispose) signalObserver.prototype[Symbol.dispose] = signalObserver.prototype.clear;
