"use strict";

const symbRepeatElementScope = Symbol("pluginRepeatElementScope");

export class pluginRepeat {
	get name(){ return 'repeat'; }
	
	constructor(ScopeDom,instance){
		this.ScopeDom = ScopeDom;
		this.instance = instance;
		this.isElementLoaded = ScopeDom.isElementLoaded;
		this.eventMap = new WeakMap(); // element, set (removeEvent cb)
		this.stateMap = new WeakMap(); // element, state
		this.afterElementDC = new WeakMap(); // element, cb
	}
	
	onConnect(plugInfo){
		let { element, attribs } = plugInfo;
		if(!element.isConnected) return;
		let repeatAttrib, ifAttrib;
		if(attribs?.size>0) for(let [attribName,attrib] of attribs){
			let { nameParts, nameKey, isDefault } = attrib;
			if(nameKey==='repeat') repeatAttrib = attrib;
			if(nameKey==='if') ifAttrib = attrib;
		}
		if(repeatAttrib && ifAttrib) return; // pluginIf will move repeat into child template
		if(repeatAttrib && this._setupRepeat(plugInfo,repeatAttrib)) return;
		if(this.stateMap.has(element)) this._reSetupRepeat(element);
	}
	
	onDisconnect(plugInfo){
		let { element } = plugInfo;
		// Element Swap
		if(this.afterElementDC.has(element)){
			let cb = this.afterElementDC.get(element);
			this.afterElementDC.delete(element);
			Promise.resolve().then(cb);
			return;
		}
		// Get State
		let state = this.stateMap.get(element);
		if(!state || !state.ready) return;
		let { anchorStart, anchorEnd, elementAnchor, mainTemplate } = state;
		if((elementAnchor?.isConnected && !anchorStart && !anchorEnd) || (elementAnchor?.isConnected && anchorStart?.isConnected && anchorEnd?.isConnected)) return; // Eg, if moved
		if(!elementAnchor?.isConnected || (anchorStart && !anchorStart?.isConnected) || (anchorEnd && !anchorEnd?.isConnected)) state.connected=false;
		// Cleanup
		if(!state.connected){
			// Remove event listeners - for elementAnchor
			if(this.eventMap.has(elementAnchor)){
				let set = this.eventMap.get(elementAnchor);
				for(let removeEvent of set) removeEvent();
				this.eventMap.delete(elementAnchor);
			}
		}
		Promise.resolve().then(()=>{
			if(state.connected) return;
			// Remove State
			if(this.stateMap.has(mainTemplate)) this.stateMap.delete(mainTemplate);
			if(this.stateMap.has(elementAnchor)) this.stateMap.delete(elementAnchor);
			if(this.stateMap.has(anchorStart)) this.stateMap.delete(anchorStart);
			if(this.stateMap.has(anchorEnd)) this.stateMap.delete(anchorEnd);
			// Remove DOM Elements
			let { domArr, anchorArr } = state;
			if(anchorArr?.length>0) for(let i=0,l=anchorArr.length; i<l; i++)  anchorArr[i].parentNode?.removeChild(anchorArr[i]);
			if(domArr?.length>0) for(let i=0,l=domArr.length; i<l; i++)  domArr[i].parentNode?.removeChild(domArr[i]);
			// Cleanup
			state.itemsArr = state.domArr = state.anchorArr = null;
		});
	}
	
	_reSetupRepeat(stateKey){
		let { instance } = this;
		let state = this.stateMap.get(stateKey);
		if(!state) return;
		let { options:{ updateEvent, updateDomEvent }, element, scopeCtrl, anchorStart, anchorEnd, elementAnchor, connected:wasConnected } = state;
		if(!state.ready) return;
		let isConnected = anchorStart?.isConnected && anchorEnd?.isConnected && elementAnchor?.isConnected;
		if(wasConnected && isConnected) return;
		state.connected = isConnected;
		if(!isConnected) return;
		// Register Events
		if(!this.eventMap.has(elementAnchor)){
			if(updateEvent?.length>0) this._registerEvent(elementAnchor,scopeCtrl.ctrl.$on(updateEvent,state.triggerExec,{ __proto__:null, capture:false, passive:true },true));
			if(updateDomEvent?.length>0) this._registerEvent(elementAnchor,scopeCtrl.$onDom(updateDomEvent,state.triggerExec,{ __proto__:null, capture:true, passive:true },true));
		}
		// Run Expressions
		state.triggerExec();
	}
	
	_setupRepeat(plugInfo,attrib){
		let { ScopeDom, instance, isElementLoaded } = this;
		let { element, elementScopeCtrl, attribs } = plugInfo;
		let { isDefault, attribute, nameKey, nameParts, value } = attrib;
		// Re-use State
		if(this.stateMap.has(element)) return this._reSetupRepeat(element);
		// Need element to be fully loaded
		if(!isElementLoaded(element)){ instance.onElementLoaded(element,this._setupRepeat.bind(this,plugInfo,attrib)); return true; }
		// Fallback value
		if(value===null) value = instance.elementAttribFallbackOptionValue(attrib,['once','node']);
		// Options
		let attribOpts = instance.elementAttribOptionsWithDefaults(element,attrib);
		let onlyOnce = this._getAttribOption(plugInfo,attrib,attribOpts,'once',false,true,true); // $repeat:once
		let updateEvent = this._getAttribOption(plugInfo,attrib,attribOpts,'update scope','$update',false,true).value; // $repeat:update-scope='event', $emit('event')
		let updateDomEvent = this._getAttribOption(plugInfo,attrib,attribOpts,'update dom','$update',false,true).value; // $repeat:update-dom='event', $emitDom('event')
		let keyName = this._getAttribOption(plugInfo,attrib,attribOpts,'key','$key',false,false).value; // $repeat:key="$key"
		let itemName = this._getAttribOption(plugInfo,attrib,attribOpts,'item','$item',false,false).value; // $repeat:item="$item"
		let scopeName = this._getAttribOption(plugInfo,attrib,attribOpts,'scope',null,false,false).value; // $repeat:scope="$repeat1"
		let useElement = this._getAttribOption(plugInfo,attrib,attribOpts,'use',null,false,true);
		let includeNode = this._getAttribOption(plugInfo,attrib,attribOpts,'node',false,true,true);
		let onUpdateEvent = this._getAttribOption(plugInfo,attrib,attribOpts,'on update',null,false,false).value; // $repeat:on-update
		let cacheList = this._getAttribOption(plugInfo,attrib,attribOpts,'cache',1,false,true).value;
		cacheList = parseFloat(cacheList)*1000; if(cacheList+''==='NaN' || cacheList<0) cacheList = 0;
		onlyOnce = onlyOnce.value;
		includeNode = includeNode.value;
		// New State
		let mainTemplate, fromElement, fromElementAnchor, fromElementConnected, elementChildren, anchorStart, anchorEnd, createAnchorAfter, elementAnchor=element;
		let state = { __proto__:null,
			options:{ __proto__:null, onlyOnce, keyName, itemName, scopeName, updateEvent, updateDomEvent, onUpdateEvent, cacheList },
			mainTemplate:null, anchorStart:null, anchorEnd:null, elementAnchor, element, scopeCtrl:elementScopeCtrl, domCache:new WeakMap(),
			exec:null, connected:true, ready:false, itemsArr:null, domArr:null, anchorArr:null, triggerExec:null, onUpdateExec:null, updateIndex:0,
		};
		// Trigger Exec
		let triggerExec = state.triggerExec = this._runExpressions.bind(this,plugInfo,state,value);
		// Find or Create Template
		let commentEnd = document.createComment(' Repeat-End-Anchor: '+value+' ');
		// <any $repeat:use="element">
		if(useElement.attribOption){
			let needsResolving = (useElement.execResult instanceof Error || useElement.value===null || (typeof useElement.value==="string" && useElement.value.length>0));
			useElement = useElement.value;
			if(needsResolving){
				if(typeof useElement==="string") useElement = element.ownerDocument.querySelector(useElement);
				if(!(useElement instanceof Node) && !isElementLoaded(instance.mainElement)){
					instance.onElementLoaded(instance.mainElement,this._setupRepeat.bind(this,plugInfo,attrib)); return true;
				}
			}
			if(!(useElement instanceof Node)) console.warn("pluginRepeat: repeat:use missing element,",element);
			if(useElement && !isElementLoaded(useElement)){
				instance.onElementLoaded(useElement,this._setupRepeat.bind(this,plugInfo,attrib)); return true;
			}
			if(useElement.nodeName!=='TEMPLATE') for(let e=useElement; e; e=e?.parentNode) if(e===element){ useElement=null; break; }
			if(useElement){
				if(useElement.nodeName==='TEMPLATE') mainTemplate = useElement;
				else {
					useElement.parentNode.insertBefore(fromElementAnchor=document.createComment(' Repeat-From-Anchor '),useElement);
					fromElement = useElement;
				}
				element.appendChild(anchorEnd=commentEnd);
			}
		}
		// <template $repeat>
		if(!mainTemplate && !fromElement && element.nodeName==='TEMPLATE'){
			mainTemplate = element;
			createAnchorAfter = element;
		}
		// <any $repeat><template>
		if(!mainTemplate && !fromElement && element.childElementCount===1 && element.children[0]?.nodeName==='TEMPLATE'){
			mainTemplate = element.children[0];
			element.appendChild(anchorEnd=commentEnd);
		}
		// <any $repeat $repeat:node>
		if(!mainTemplate && !fromElement && includeNode){
			fromElement = element;
			createAnchorAfter = element;
		}
		// <any $repeat>
		if(!mainTemplate && !fromElement && !includeNode){
			fromElement = element;
			elementChildren = document.createDocumentFragment();
			for(let e of [...element.childNodes]) elementChildren.appendChild(e);
			element.appendChild(anchorEnd=commentEnd);
		}
		// Create Anchors
		if(createAnchorAfter){
			element.parentNode.insertBefore(anchorEnd=commentEnd,element.nextSibling);
		}
		if(anchorEnd && !anchorStart){
			anchorEnd.parentNode.insertBefore(anchorStart=document.createComment(' Repeat-Start-Anchor: '+value+' '),anchorEnd);
		}
		// Remove fromElement & Create template if ready
		if(!mainTemplate && fromElement && !elementChildren){
			fromElementConnected = fromElement.isConnected;
			fromElement.remove();
			if(!fromElementConnected) this._createTemplateFromElement(state,{ __proto__:null, fromElement, fromElementAnchor, includeNode, attribute, attribOpts });
			mainTemplate = state.mainTemplate;
		}
		// State
		if(mainTemplate && !(mainTemplate.content?.childNodes?.length>0)){ console.warn("pluginRepeat: template has no content"); return; }
		if(mainTemplate) state.mainTemplate = mainTemplate;
		state.anchorStart = anchorStart;
		state.anchorEnd = anchorEnd;
		this.stateMap.set(anchorStart,state);
		this.stateMap.set(anchorEnd,state);
		// Continue when ready
		function finishSetupPluginRepeat(){
			// Finish template creation
			if(!mainTemplate && fromElement && fromElementConnected){
				this._createTemplateFromElement(state,{ __proto__:null, fromElement, includeNode, fromElementAnchor, attribute, attribOpts });
				mainTemplate = state.mainTemplate;
				if(!fromElement.isConnected) elementAnchor = state.elementAnchor = mainTemplate;
			}
			else if(!mainTemplate && elementChildren){
				mainTemplate = state.mainTemplate = document.createElement('template');
				mainTemplate.content.appendChild(elementChildren);
				anchorStart.parentNode.insertBefore(mainTemplate,anchorStart);
			}
			// Additional Anchors
			if(!elementAnchor?.isConnected && mainTemplate?.isConnected) elementAnchor = mainTemplate;
			if(mainTemplate.parentNode===element) this.stateMap.set(mainTemplate,state);
			// Fallback elementAnchor
			if(useElement===mainTemplate || mainTemplate.parentNode!==anchorStart.parentNode) elementAnchor = anchorStart;
			// Set scope
			if(elementAnchor!==element) instance.elementScopeSetAlias(elementAnchor,element,true);
			// Ready
			state.ready = true;
			state.elementAnchor = elementAnchor;
			this.stateMap.set(elementAnchor,state);
			state.scopeCtrl = instance.elementScopeCtrl(elementAnchor);
			// Check Connected
			if(!anchorStart.isConnected || !anchorEnd.isConnected || !elementAnchor.isConnected){ state.connected=false; }
			if(state.connected){
				// Add $repeat() to element & element context
				state.scopeCtrl.execContext.$repeat = elementAnchor.$repeat = triggerExec;
				// Register Events
				if(updateEvent?.length>0) this._registerEvent(elementAnchor,state.scopeCtrl.ctrl.$on(updateEvent,triggerExec,{ __proto__:null, capture:false, passive:true },true));
				if(updateDomEvent?.length>0) this._registerEvent(elementAnchor,state.scopeCtrl.$onDom(updateDomEvent,triggerExec,{ __proto__:null, capture:true, passive:true },true));
			}
			// Run Expressions
			this._runExpressions(plugInfo,state,value);
		};
		if(fromElement && fromElementConnected) this.afterElementDC.set(fromElement,finishSetupPluginRepeat.bind(this));
		else instance.onReady(finishSetupPluginRepeat.bind(this),false);
		return true;
	}
	_createTemplateFromElement(state,{ __proto__=null, fromElement, includeNode, fromElementAnchor=null, attribute, attribOpts }){
		let { mainTemplate, anchorStart } = state;
		if(mainTemplate || !fromElement) return;
		this.stateMap.delete(fromElement);
		let newElement = fromElement.cloneNode(true);
		if(fromElementAnchor){
			fromElementAnchor.parentNode.insertBefore(fromElement,fromElementAnchor);
			fromElementAnchor.remove();
		}
		anchorStart.parentNode.insertBefore(document.createComment(' Repeat-Use: '+(newElement.cloneNode(false).outerHTML||'Node: '+newElement.textContent)+' '),anchorStart);
		mainTemplate = state.mainTemplate = document.createElement('template');
		this.stateMap.set(mainTemplate,state);
		if(includeNode) mainTemplate.content.appendChild(newElement);
		else for(let e of [...newElement.childNodes]) mainTemplate.content.appendChild(e);
		if(includeNode){
			this.ScopeDom.setAttribute(mainTemplate,attribute,newElement.getAttribute(attribute)||'');
			newElement.removeAttribute(attribute);
			for(let [n,opt] of attribOpts) if(opt.attribute && !opt.isDefault){
				if(!mainTemplate.hasAttribute(opt.attribute)) this.ScopeDom.setAttribute(mainTemplate,opt.attribute,opt.value||'');
				newElement.removeAttribute(opt.attribute);
			}
			if(newElement.id?.length>0){
				mainTemplate.id = newElement.id;
				newElement.removeAttribute('id');
			}
		}
		anchorStart.parentNode.insertBefore(mainTemplate,anchorStart);
	}
	
	_registerEvent(element,removeEvent){
		if(!this.eventMap.has(element)) this.eventMap.set(element,new Set());
		this.eventMap.get(element).add(removeEvent);
	}
	_getAttribOption(plugInfo,attrib,attribOpts,optName,defaultValue=null,trueOnEmpty=false,runExp=false){
		let { instance } = this;
		let { element, elementScopeCtrl, attribs } = plugInfo;
		let { isDefault, attribute, nameKey, nameParts, value } = attrib;
		let optValue = defaultValue, opt = attribOpts.get(optName), execResult;
		if(trueOnEmpty && (opt?.value==='' || opt?.value===null)) optValue = true;
		else if(runExp && opt?.value!==void 0){
			let { result } = instance.elementExecExp(elementScopeCtrl,opt.value,null,{ silentHas:true, useReturn:true });
			execResult = result;
			if(typeof result!==void 0) optValue = result;
		}
		else if(!runExp && opt?.value?.length>0) optValue = opt.value;
		return { __proto__:null, value:optValue, raw:opt?.value, attribOption:opt, isDefault, execResult };
	}
	
	_runExpressions(plugInfo,state,exp){
		let { instance } = this;
		let { options, mainTemplate, elementAnchor, anchorStart, anchorEnd, exec, connected, ready, updateIndex } = state;
		let { onlyOnce, onUpdateEvent } = options;
		if(!ready || !connected) return;
		if(onlyOnce && exec) return;
		if(anchorStart.parentNode!==anchorEnd.parentNode){ console.warn("pluginRepeat: Repeat Anchors have been modified, cannot run expressions.",{ mainTemplate, elementAnchor, anchorStart, anchorEnd, exp }); return; }
		// Only run if anchors are connected
		if(!anchorStart.isConnected || !anchorEnd.isConnected || !elementAnchor.isConnected) return;
		// Build Exec for On Update
		if(onUpdateEvent?.length>0 && !state.onUpdateExec) state.onUpdateExec = instance.elementExecExp(state.scopeCtrl,onUpdateEvent,null,{ silentHas:true, useReturn:false, run:false });
		// Get Items
		if(!exec) state.exec = exec = instance.elementExecExp(state.scopeCtrl,exp,null,{ silentHas:true, useReturn:true, run:false });
		let execResult = exec.runFn();
		// Resolve Signal
		execResult = this.ScopeDom.resolveSignal(execResult);
		// Handle fallback when Promise on first update
		if(state.itemsArr===null && execResult instanceof Promise){
			this._handleRepeatDOM(plugInfo,state,updateIndex,[]);
			updateIndex = state.updateIndex;
		}
		// Handle Result
		if(execResult instanceof Promise) this.ScopeDom.animFrameHelper.promiseToRAF(execResult,this._handleRepeatDOM.bind(this,plugInfo,state,updateIndex));
		else this._handleRepeatDOM(plugInfo,state,updateIndex,execResult);
	}
	
	_handleRepeatDOM(plugInfo,state,callUpdateIndex,execResult){
		let { instance } = this;
		let { element } = plugInfo;
		let { options, mainTemplate, elementAnchor, anchorStart, anchorEnd, itemsArr:oldItemsArr, domArr:oldDomArr, anchorArr:oldAnchorArr, domCache, updateIndex } = state;
		let { keyName, itemName, scopeName, cacheList:cacheLimit } = options;
		// Ignore old calls
		if(updateIndex>callUpdateIndex) return;
		state.updateIndex++;
		// Update state
		element.$repeatResult = elementAnchor.$repeatResult = execResult;
		// Resolve Signal
		execResult = this.ScopeDom.resolveSignal(execResult);
		// Convert list into entries [[key,value],...]
		let itemsArr = [], domArr = [], anchorArr = [], isArr=false;
		if(execResult instanceof Map){ itemsArr=Object.entries(execResult); }
		else if(execResult instanceof Set){ itemsArr=Object.entries([...execResult]); isArr=true; }
		else if(execResult instanceof Array){ itemsArr=Object.entries(execResult); isArr=true; }
		else if(Object(execResult)===execResult){ itemsArr=Object.entries(execResult); }
		else { execResult=[]; itemsArr=[]; isArr=true; }
		// Find new items in old items
		if(!oldItemsArr)oldItemsArr=[]; if(!oldDomArr)oldDomArr=[]; if(!oldAnchorArr)oldAnchorArr=[];
		for(let i=0,l=itemsArr.length; i<l; i++){
			let [key,item] = itemsArr[i];
			let [oldKey,oldItem] = oldItemsArr[i]||[];
			if(oldKey!==void 0 && (isArr || oldKey===key) && oldItem===item){
				domArr[i] = oldDomArr[i];
				anchorArr[i] = oldAnchorArr[i];
				continue;
			}
			if(oldKey!==void 0) for(let j=0,k=oldItemsArr.length; j<k; j++){
				let [oKey,oItem] = oldItemsArr[j];
				if((isArr || oKey===key) && oItem===item && domArr.indexOf(oldDomArr[j])===-1 && anchorArr.indexOf(oldAnchorArr[j])===-1){
					domArr[i] = oldDomArr[j];
					anchorArr[i] = oldAnchorArr[j];
					break;
				}
			}
		}
		// DOM Cache
		let usableDOMCache = new Map();
		if(cacheLimit>0 && oldItemsArr.length===oldAnchorArr.length){
			// Find current (old) DOM nodes
			let currentDomNodes = [];
			if(oldAnchorArr.length>0) for(let e=anchorStart.nextSibling, i=null; e && e!==anchorEnd; e=e.nextSibling){
				let oai = oldAnchorArr.indexOf(e);
				if(oai!==-1){ i=oai; continue; }
				if(i!==null){
					if(!currentDomNodes[i]) currentDomNodes[i] = [];
					currentDomNodes[i].push(e);
				}
			}
			// Cache current (old) DOM nodes against old items
			let now = Date.now(), itemDomCache = domCache.get(execResult), skipItems = [];
			if(currentDomNodes.length===oldItemsArr.length){
				if(!itemDomCache) domCache.set(execResult,itemDomCache=new WeakMap());
				for(let i=0,l=currentDomNodes.length; i<l; i++){
					let [key,item] = oldItemsArr[i];
					if(skipItems.indexOf(item)!==-1 || Object(item)!==item) continue;
					let nodes = currentDomNodes[i];
					if(!usableDOMCache.has(item)){
						itemDomCache.set(item,[now,nodes]);
						usableDOMCache.set(item,nodes);
					} else {
						// Multiple of same item in array, so Skip & Remove nodes from cache
						skipItems.push(item);
						itemDomCache.delete(item);
						usableDOMCache.delete(item);
					}
				}
			}
			// Find re-usable DOM Nodes in cache
			if(itemDomCache) for(let i=0,l=itemsArr.length; i<l; i++){
				let [key,item] = itemsArr[i];
				if(!usableDOMCache.has(item)){
					if(itemDomCache.has(item)){
						let [ts,nodes] = itemDomCache.get(item);
						if(now-ts<=cacheLimit) usableDOMCache.set(item,nodes);
						else itemDomCache.delete(item);
					}
				}
			}
		}
		// Setup scopes & expected DOM
		let eScopes = instance.elementExtraScopes;
		let expectedDOM = new Set();
		let usedNodes = new Set(), usedAnchors = new Set();
		for(let i=0,l=itemsArr.length; i<l; i++){
			let [key,item] = itemsArr[i];
			let nodes = usableDOMCache.get(item);
			if(!nodes || nodes.length===0) nodes = domArr[i];
			let anchor = anchorArr[i];
			// Only use nodes & anchors once
			if(nodes && usedNodes.has(nodes)) nodes = null;
			if(anchor && usedAnchors.has(anchor)) anchor = null;
			// Dom Nodes
			if(!nodes || nodes.length===0){
				nodes = [...mainTemplate.content.cloneNode(true).childNodes];
				// Alias node scopes
				if(anchorStart.parentNode!==elementAnchor) for(let e of nodes) instance.elementScopeSetAlias(e,elementAnchor);
			}
			domArr[i] = nodes;
			// Anchor
			let anchorData = ' Repeat-Item-Anchor: '+(isArr?'Index '+key:'Key '+key)+' ';
			if(!anchor) anchor = document.createComment(anchorData);
			else if(anchor.data!==anchorData) anchor.data = anchorData;
			anchorArr[i] = anchor;
			// Mark as used
			usedNodes.add(nodes);
			usedAnchors.add(anchor);
			// Set Element Scopes
			let [$prevKey,$prevItem] = itemsArr[i-1]||[], [$nextKey,$nextItem] = itemsArr[i+1]||[];
			let scope = { __proto__:null, $index:i, $isFirst:i===0, $isLast:i===l-1, [keyName]:key, [itemName]:item, $prevKey, $prevItem, $nextKey, $nextItem };
			// if(scopeName!==null && scopeName?.length>0) scope = { __proto__:null, [scopeName]:scope }; // $repeat:scope="$repeat1" // $repeat1.$item
			scope[symbRepeatElementScope] = elementAnchor;
			anchor[symbRepeatElementScope] = elementAnchor;
			// Set scope on anchor, alias on nodes
			for(let e of [anchor,...nodes]){
				let scopesArr = eScopes.get(e)||[], scopeIndex = -1;
				for(let i=0,l=scopesArr.length; i<l; i++){
					let s = scopesArr[i];
					if(s[symbRepeatElementScope]!==elementAnchor) continue;
					if(e===anchor){
						if(scope[scopeName] && s[scopeName]) Object.assign(s[scopeName],scope[scopeName]);
						else Object.assign(s,scope); // Update existing scope, use assign, so references remain correct
					}
					else scopesArr[i] = anchor; // Alias to anchor's element scope
					scopeIndex = i;
					break;
				}
				if(scopeIndex===-1){ scopesArr.unshift(scope); scopeIndex=0; } // Add new scope
				if(elementAnchor!==e.parentNode){
					let eaIndex = scopesArr.length>1 ? scopesArr.indexOf(elementAnchor) : -1; // Find elementAnchor
					if(eaIndex!==-1 && eaIndex!==scopeIndex+1){ scopesArr.splice(eaIndex,1); eaIndex=-1; } // Remove elementAnchor
					if(eaIndex===-1) scopesArr.splice(scopeIndex+1,0,elementAnchor); // Add elementAnchor after scopeIndex
				}
				if(!eScopes.has(e)) eScopes.set(e,scopesArr); // Save element scopes
			}
			// Add to expected DOM
			expectedDOM.add(anchor);
			for(let e of nodes) expectedDOM.add(e);
		}
		// Quick-Morph live DOM with expected DOM
		let expectedArr=[...expectedDOM], foundDOM=new Set();
		for(let e=anchorStart.nextSibling; e && e!==anchorEnd; e=e.nextSibling) foundDOM.add(e);
		let foundArr = [...foundDOM], fIndex=0, tmpFragment=document.createDocumentFragment();
		for(let i=0,l=expectedArr.length; i<l; i++){
			let expected = expectedArr[i];
			let found = foundArr[fIndex];
			// If expected exists later, remove chunks of old DOM
			if(found && found!==expected){
				let foundAt = foundArr.indexOf(expected);
				if(foundAt>fIndex){
					let oldFI = fIndex;
					found = foundArr[fIndex=foundAt];
					for(let j=oldFI; j<fIndex; j++) foundArr[j].parentNode?.removeChild(foundArr[j]);
				}
			}
			// Remove old dom
			if(found && found!==expected){
				found.parentNode?.removeChild(found);
				fIndex++;
			}
			// Insert expected dom
			if(found===expected){
				if(tmpFragment.childNodes.length>0){
					found.parentNode.insertBefore(tmpFragment,found);
					tmpFragment = document.createDocumentFragment();
				}
				fIndex++;
			}
			else tmpFragment.appendChild(expected);
		}
		// Remove remaining old dom
		if(fIndex<foundArr.length) for(let i=fIndex,l=foundArr.length; i<l; i++) foundArr[i].parentNode?.removeChild(foundArr[i]);
		// Insert remaining expected dom
		if(tmpFragment.childNodes.length>0) anchorEnd.parentNode.insertBefore(tmpFragment,anchorEnd);
		// Update state
		state.itemsArr=itemsArr; state.domArr=domArr; state.anchorArr=anchorArr;
		element.$updated = elementAnchor.$updated = true;
		// On Update Event
		if(state.onUpdateExec) state.onUpdateExec.runFn();
	}
	
}

let win = typeof window!=='undefined' && window;
if(win) win.ScopeDom?.pluginAdd?.(pluginRepeat) || ((win.ScopeDomPlugins=win.ScopeDomPlugins||{}).pluginRepeat=pluginRepeat);
