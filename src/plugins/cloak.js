"use strict";

let styleReady = document.createElement('style');
styleReady.setAttribute('type','text/css');
styleReady.appendChild(document.createTextNode(`*[\\$cloak], *[\\$cloak\\:dom] { display:none !important; }`)); // ,*[\\$cloak\\:dom]
document.head.prepend(styleReady);

export class pluginCloak {
	get name(){ return 'cloak'; }
	
	constructor(ScopeDom,instance){
		this.ScopeDom = ScopeDom;
		this.instance = instance;
		this.eventMap = new WeakMap(); // element, set (removeEvent cb)
		this.stateMap = new Map(); // element, state
	}
	
	onConnect(plugInfo){
		let { ScopeDom, instance } = this;
		let { element, elementScopeCtrl, attribs } = plugInfo;
		if(element.nodeName==='TEMPLATE' || !element.isConnected) return;
		if(!attribs || attribs.size===0 || !attribs.has('cloak')) return;
		let attrib = attribs.get('cloak');
		let { isDefault, attribute, nameKey, nameParts, value } = attrib;
		// Setup Options
		let attribOpts = instance.elementAttribOptionsWithDefaults(element,attrib);
		// Fallback value
		if(value===null) value = instance.elementAttribFallbackOptionValue(attrib,['dom','swap']);
		// Options
		let updateEvent = instance.elementAttribParseOption(element,attribOpts,'update scope',{ default:'$update', emptyTrue:false, runExp:true }).value; // $cloak:update-scope='event', $emit('event')
		let updateDomEvent = instance.elementAttribParseOption(element,attribOpts,'update dom',{ default:'$update', emptyTrue:false, runExp:true }).value; // $cloak:update-dom='event', $emitDom('event')
		let onShowEvent = instance.elementAttribParseOption(element,attribOpts,'on show',{ default:null, emptyTrue:false, runExp:false }).value; // $cloak:on-show='exp'
		let anchor, anchorScopeCtrl, domSwap = instance.elementAttribParseOption(element,attribOpts,'dom',{ default:false, emptyTrue:true, runExp:true }).value; // $cloak:dom
		let tplSwap = element.nodeName==='TEMPLATE' ? instance.elementAttribParseOption(element,attribOpts,'swap',{ default:false, emptyTrue:true, runExp:true }).value : false; // <template $cloak:swap>
		// State
		let state = { elementScopeCtrl, attrib, attribOpts, anchor, anchorScopeCtrl, onShowEvent, tplSwap };
		this.stateMap.set(element,state);
		// Build Scope
		state.scope = {
			$element:element, $anchor:null,
			plugins: this._hasPlugins.bind(this),
			loaded: ScopeDom.isElementLoaded.bind(null,element,false,false),
			ready: instance.isReady.bind(instance),
		};
		if(value===null || value==='') value = 'ready() && loaded()';
		// Expression Function
		let runExpFn = state.runExpFn = this._runExpression.bind(this,plugInfo,attrib,state,value);
		// Early Check
		if(runExpFn()) return;
		// Swap DOM
		if(domSwap && element.nodeName!=='TEMPLATE'){
			state.anchor = anchor = document.createComment(' Cloak-Anchor: '+element.cloneNode(false).outerHTML+' ');
			state.scope.$anchor = anchor;
			state.scope.loaded = ScopeDom.isElementLoaded.bind(null,anchor,false,false),
			element.replaceWith(anchor);
			this._removeAttribs(element,attrib,attribOpts);
			anchorScopeCtrl = state.anchorScopeCtrl = this.instance.elementScopeCtrl(anchor);
		}
		// Register Events
		if(updateEvent?.length>0) this._registerEvent(element,elementScopeCtrl.ctrl.$on(updateEvent,runExpFn,{ capture:false, passive:true },true));
		if(updateDomEvent?.length>0) this._registerEvent(element,elementScopeCtrl.$onDom(updateDomEvent,runExpFn,{ capture:true, passive:true },true));
		if(updateDomEvent?.length>0 && anchor) this._registerEvent(element,anchorScopeCtrl.$onDom(updateDomEvent,runExpFn,{ capture:true, passive:true },true));
		// Listen
		instance.onElementLoaded(anchor||element,runExpFn);
		instance.onReady(runExpFn,false);
	}
	
	onDisconnect(plugInfo){
		let { element } = plugInfo;
		let state = this.stateMap.get(element);
		if(!state) return;
		let { attrib, anchor } = state;
		if(anchor?.isConnected && !element.isConnected) return;
		this._unCloak(plugInfo,attrib,false);
	}
	
	onPluginAdd(plugin){
		if(plugin===this) return;
		for(let [e,state] of this.stateMap) Promise.resolve().then(state.runExpFn);
	}
	
	_registerEvent(element,removeEvent){
		if(!this.eventMap.has(element)) this.eventMap.set(element,new Set());
		this.eventMap.get(element).add(removeEvent);
	}
	
	_removeAttribs(element,attrib,attribOpts){
		if(!element.hasAttribute(attrib.attribute)) return;
		element.removeAttribute(attrib.attribute);
		for(let [n,opt] of attribOpts) element.removeAttribute(opt.attribute);
	}
	
	_unCloak(plugInfo,attrib,removeAttrib=true){
		let { instance } = this;
		let { element } = plugInfo;
		// DOM Swap
		let state = this.stateMap.get(element);
		let { attribOpts, anchor, tplSwap } = state;
		// Remove attribute
		if(removeAttrib) this._removeAttribs(element,attrib,attribOpts);
		// Remove from state
		this.stateMap.delete(element);
		// Remove event listeners
		if(this.eventMap.has(element)){
			let set = this.eventMap.get(element);
			for(let removeEvent of set) removeEvent();
			this.eventMap.delete(element);
		}
		// Swap DOM
		if(anchor?.isConnected && !element.isConnected){
			instance.elementScopeSetAlias(element,anchor);
			anchor.replaceWith(element);
		}
		// Template Swap
		if(tplSwap){
			
		}
	}
	
	_hasPlugins(...pluginNames){
		let registeredNames = [...this.instance.plugins.register].filter(obj=>obj?.name?.length>0).map(obj=>obj.name);
		return pluginNames.every(name=>registeredNames.indexOf(name)!==-1);
	}
	
	_runExpression(plugInfo,attrib,state,exp){
		let { instance } = this;
		let { element, elementScopeCtrl } = plugInfo;
		let { anchorScopeCtrl, onShowEvent, scope } = state;
		if(!this.stateMap.has(element)) return true;
		// Run Expression
		let { result } = instance.elementExecExp(anchorScopeCtrl||elementScopeCtrl,exp,scope,{ silentHas:true, useReturn:true, run:true });
		if(result){
			this._unCloak(plugInfo,attrib,true);
			if(onShowEvent?.length>0) instance.elementExecExp(elementScopeCtrl,onShowEvent,scope,{ silentHas:true, useReturn:false, run:true });
		}
		return result;
	}
	
}

let win = typeof window!=='undefined' && window;
if(win) win.ScopeDom?.pluginAdd?.(pluginCloak) || ((win.ScopeDomPlugins=win.ScopeDomPlugins||{}).pluginCloak=pluginCloak);
