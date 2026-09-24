"use strict";
/** @typedef {import('../scopedom.js').default} ScopeDom */

/** @type {HTMLStyleElement} Pre-injected CSS for hiding elements with $cloak attribute. */
export const styleReady = document.createElement('style');
styleReady.setAttribute('type','text/css');
styleReady.appendChild(document.createTextNode(`*[\\$cloak], *[\\$cloak\\:dom] { display:none !important; }`));
document.head.prepend(styleReady);

/**
 * $cloak - hides an element until a condition becomes truthy, then reveals it.
 * 
 * A plugin that hides any element carrying a $cloak attribute until an expression
 * evaluates truthy ('ready() && loaded()' by default), then 'uncloaks' it by removing
 * the tracked per-element state and event subscriptions via #unCloak. The attribute
 * may also be placed on a <template> to trigger the swap modes below.
 * 
 * The attribute and its $cloak:* options:
 *   $cloak             reveal expression (default ready() && loaded())
 *   $cloak:dom         DOM swap - replace the element with an anchor comment node
 *   $cloak:swap        template swap - clone a template into place (only on <template>)
 *   $cloak:on-show     add an expression run once on reveal
 *   $cloak:update-scope re-evaluate when the scope emits the given event
 *   $cloak:update-dom  re-evaluate when the DOM emits the given event
 * 
 * @class pluginCloak
 */
export class pluginCloak {

	/** @returns {string} The name of the plugin. */
	get name(){ return 'cloak'; }
	static get name(){ return 'cloak'; }
	
	/** @type {ScopeDom} ScopeDom class */
	ScopeDom;
	/** @type {ScopeDom} ScopeDom instance */
	instance;
	/** @type {WeakMap<HTMLElement, Set<Function>>} Per-element event removal callbacks */
	#eventMap;
	/** @type {Map<HTMLElement, object>} Per-element cloak state */
	#stateMap;
	
	/**
	 * Initialises the pluginCloak instance and installs the per-element event/state tracking maps.
	 * 
	 * @param {ScopeDom} ScopeDom The ScopeDom class reference
	 * @param {ScopeDom} instance The ScopeDom instance
	 */
	constructor(ScopeDom,instance){
		this.ScopeDom = ScopeDom;
		this.instance = instance;
		this.#eventMap = new WeakMap();
		this.#stateMap = new Map();
	}
	
	/**
	 * Called when the plugin is connected to an element.
	 * 
	 * Reads the $cloak attribute (and its $cloak:* options) to decide cloaking behaviour.
	 * 
	 * When conditions are met the element is "uncloaked" (revealed); its tracked state and
	 * per-element events are then removed by #unCloak.
	 * 
	 * @param {Object} plugInfo Information about the plugin connection
	 * @param {HTMLElement} plugInfo.element The element being connected
	 * @param {Object} plugInfo.elementScopeCtrl The element's scope-controller context (has `.ctrl` plus the `$on`/`$onDom` bindings)
	 * @param {Map<string, Object>} plugInfo.attribs The ScopeDom parsed attributes of the element
	 */
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
		this.#stateMap.set(element,state);
		/**
		 * Build expression scope
		 * @property {HTMLElement} $element The connected element
		 * @property {Comment|null} $anchor The :dom/:swap anchor comment (null until swap mode sets it)
		 * @property {Function} plugins ...names - true iff every named plugin is registered on the instance
		 * @property {Function} loaded isElementLoaded() on the element (or anchor in swap mode)
		 * @property {Function} ready instance.isReady()
		 */
		state.scope = {
			$element: element, $anchor: null,
			plugins: this.#hasPlugins.bind(this),
			loaded: instance.isElementLoaded.bind(instance,element,false,false),
			ready: instance.isReady.bind(instance),
		};
		if(value===null || value==='') value = 'ready() && loaded()';
		// Expression Function
		let runExpFn = state.runExpFn = this.#runExpression.bind(this,plugInfo,attrib,state,value);
		// Swap DOM
		if((domSwap && element.nodeName!=='TEMPLATE') || tplSwap){
			state.anchor = anchor = document.createComment(` Cloak-Anchor ${instance.dev?element.cloneNode(false).outerHTML:''} `);
			state.scope.$anchor = anchor;
			state.scope.loaded = instance.isElementLoaded.bind(instance,anchor,false,false);
			instance.elementScopeSetAlias(anchor,element);
			element.replaceWith(anchor);
			if(domSwap) this.#removeAttribs(element,attrib,attribOpts);
			anchorScopeCtrl = state.anchorScopeCtrl = this.instance.elementScopeCtrl(anchor);
		}
		// Register Events
		if(updateEvent?.length>0) this.#registerEventRemoval(element,elementScopeCtrl.ctrl.$on(updateEvent,runExpFn,{ capture:false, passive:true },true));
		if(updateEvent?.length>0 && anchor) this.#registerEventRemoval(anchor,anchorScopeCtrl.ctrl.$on(updateEvent,runExpFn,{ capture:false, passive:true },true));
		if(updateDomEvent?.length>0) this.#registerEventRemoval(element,elementScopeCtrl.$onDom(updateDomEvent,runExpFn,{ capture:true, passive:true },true));
		if(updateDomEvent?.length>0 && anchor) this.#registerEventRemoval(anchor,anchorScopeCtrl.$onDom(updateDomEvent,runExpFn,{ capture:true, passive:true },true));
		// Listen
		instance.onElementLoaded(anchor||element,runExpFn);
		instance.onReady(runExpFn,false);
	}
	
	/**
	 * Called when the plugin disconnects from an element.
	 * 
	 * If the element's anchor is connected but the element is not, it restores the element
	 * from the anchor DOM swap. Otherwise unCloak is called without attribute removal.
	 * Used when an element is removed from the DOM tree.
	 * 
	 * @param {Object} plugInfo Information about the plugin connection (contains `element`)
	 */
	onDisconnect(plugInfo){
		let { element } = plugInfo;
		let state = this.#stateMap.get(element);
		if(!state) return;
		let { attrib, anchor } = state;
		if(anchor?.isConnected && !element.isConnected) return;
		this.#unCloak(plugInfo,attrib,false);
	}
	
	/**
	 * Called when a new plugin is added to the instance.
	 * Re-evaluates the expression for all tracked elements.
	 * 
	 * @param {Object} plugin The plugin being added
	 */
	onPluginAdd(plugin){
		if(plugin===this) return;
		for(let [e,state] of this.#stateMap) Promise.resolve().then(state.runExpFn);
	}
	
	/**
	 * Registers an event removal function.
	 * 
	 * @private
	 * @param {HTMLElement} element The element to track
	 * @param {Function} removeEvent The event removal callback
	 */
	#registerEventRemoval(element,removeEvent){
		if(!this.#eventMap.has(element)) this.#eventMap.set(element,new Set());
		this.#eventMap.get(element).add(removeEvent);
	}
	
	/**
	 * Removes cloak attributes from an element.
	 * 
	 * @private
	 * @param {HTMLElement} element The element to modify
	 * @param {Object} attrib The cloak attribute information
	 * @param {Map} attribOpts The attribute options
	 */
	#removeAttribs(element,attrib,attribOpts){
		if(!element.hasAttribute(attrib.attribute)) return;
		element.removeAttribute(attrib.attribute);
		for(let [n,opt] of attribOpts) element.removeAttribute(opt.attribute);
	}
	
	/**
	 * Uncloaks an element: removes cloak attributes, clears all event listeners, deletes state tracking,
	 * and restores the element from its anchor node (in DOM swap mode).
	 * 
	 * @private
	 * @param {Object} plugInfo The plugin connection info (contains element and scope controller)
	 * @param {Object} attrib The cloak attribute definition (contains attribute name and options)
	 * @param {boolean} [removeAttrib=true] Remove cloak attributes from the element (true by default)
	 */
	#unCloak(plugInfo,attrib,removeAttrib=true){
		let { instance } = this;
		let { element } = plugInfo;
		// DOM Swap
		let state = this.#stateMap.get(element);
		let { attribOpts, anchor, tplSwap } = state;
		// Remove attribute
		if(removeAttrib) this.#removeAttribs(element,attrib,attribOpts);
		// Remove from state
		this.#stateMap.delete(element);
		// Remove event listeners
		for(let e of [element,anchor]) if(e && this.#eventMap.has(e)){
			let set = this.#eventMap.get(e);
			for(let removeEvent of set) removeEvent();
			this.#eventMap.delete(e);
		}
		// Template Swap $cloak:swap
		if(tplSwap && anchor?.isConnected && !element.isConnected){
			for(let e of Array.from(element.content.cloneNode(true).childNodes)){
				instance.elementScopeSetAlias(e,anchor);
				anchor.parentNode.insertBefore(e,anchor);
			}
			anchor.parentNode.removeChild(anchor);
		}
		// Swap DOM
		else if(anchor?.isConnected && !element.isConnected){
			instance.elementScopeSetAlias(element,anchor);
			anchor.replaceWith(element);
		}
	}
	
	/**
	 * Checks if specified plugins are registered.
	 * 
	 * @private
	 * @param {...string} pluginNames The names of the plugins to check
	 * @returns {boolean} True if all specified plugins are registered
	 */
	#hasPlugins(...pluginNames){
		let registeredNames = Array.from(this.instance.plugins.register).filter(obj=>obj?.name?.length>0).map(obj=>obj.name);
		return pluginNames.every(name=>registeredNames.indexOf(name)!==-1);
	}
	
	/**
	 * Runs an expression and handles the result.
	 * 
	 * Executes the expression against the scope, then calls #unCloak on truthy results
	 * and triggers onShowEvent if registered. Delegates to instance.elementExecExp with silentHas:true.
	 * 
	 * @private
	 * @param {Object} plugInfo Information about the plugin connection (contains element, elementScopeCtrl)
	 * @param {Object} attrib The cloak attribute information
	 * @param {Object} state The state object (contains anchorScopeCtrl, onShowEvent, scope)
	 * @param {string} exp The expression string to evaluate
	 * @returns {any} The raw expression result (truthy -> element is uncovered; falsy -> kept cloaked)
	 */
	#runExpression(plugInfo,attrib,state,exp){
		let { instance } = this;
		let { element, elementScopeCtrl } = plugInfo;
		let { anchorScopeCtrl, onShowEvent, scope } = state;
		if(!this.#stateMap.has(element)) return true;
		// Run Expression
		let { result } = instance.elementExecExp(anchorScopeCtrl||elementScopeCtrl,exp,scope,{ silentHas:true, useReturn:true, run:true });
		if(result){
			this.#unCloak(plugInfo,attrib,true);
			if(onShowEvent?.length>0) instance.elementExecExp(elementScopeCtrl,onShowEvent,scope,{ silentHas:true, useReturn:false, run:true });
		}
		return result;
	}
	
}

/** Auto-register: prefer ScopeDom.pluginAdd, else fallback to the ScopeDomPlugins discovery object. */
let win = typeof window!=='undefined' && window;
if(win) win.ScopeDom?.pluginAdd?.(pluginCloak) || ((win.ScopeDomPlugins=win.ScopeDomPlugins||{}).pluginCloak=pluginCloak);
