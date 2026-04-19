"use strict";

const elementNodeType = document.ELEMENT_NODE;
const textNodeType = document.TEXT_NODE;
let isTextNodeSolid = null;
let hasSetHTMLSupport = false;

(()=>{
	let e=document.createElement('div'), tn=document.createTextNode('text'); e.appendChild(tn);
	isTextNodeSolid = function isTextNodeSolid(data){ tn.data=data; return e.innerText.length>0 && (tn.data='',!0); };
	hasSetHTMLSupport = 'setHTML' in e && typeof e.setHTML==='function';
})();

/**
 * Plugin for parsing expressions within text nodes and attributes.
 * Supports features like text parsing, tree parsing, once-only execution,
 * and attribute binding (safe and HTML).
 *
 * @class pluginParse
 */
export class pluginParse {
	
	/**
	 * @returns {string} The name of the plugin.
	*/
	get name(){ return 'parse'; }
	static get name(){ return 'parse'; }
	
	#isElementLoaded;
	#eventRemovalMap; #mutationObserverMap; #intersectionObserverMap;
	#parseStateMap; #parsedTextNodesSet; #childExcludeTextSet; #expressionRegexCache;
	
	/**
	 * @param {Object} ScopeDom - The ScopeDom class.
	 * @param {Object} instance - The ScopeDom instance.
	*/
	constructor(ScopeDom,instance){
		this.ScopeDom = ScopeDom;
		this.instance = instance;
		this.#isElementLoaded = ScopeDom.isElementLoaded;
		this.#eventRemovalMap = new WeakMap(); // per element-set
		this.#mutationObserverMap = new WeakMap(); // per element
		this.#intersectionObserverMap = new WeakMap(); // per element
		this.#parseStateMap = new WeakMap(); // per element
		this.#parsedTextNodesSet = new WeakSet(); // only textNode
		this.#childExcludeTextSet = new WeakSet(); // only child elements
		this.#expressionRegexCache = new Map();
	}
	
	/**
	 * Called when the plugin is connected to an element.
	 * Checks for the presence of the 'parse' attribute and sets up parsing.
	 *
	 * @param {Object} plugInfo - Information about the plugin connection.
	 * @param {HTMLElement} plugInfo.element - The element being connected.
	 * @param {Map<string, Object>} plugInfo.attribs - The ScopeDom parsed attributes of the element.
	*/
	onConnect(plugInfo){
		let { element, attribs } = plugInfo;
		if(!element.isConnected) return;
		let parseAttribute;
		if(attribs?.size>0) for(let [attribName,attrib] of attribs){
			let { nameParts, nameKey, isDefault } = attrib;
			if(nameKey==='parse') parseAttribute = attrib;
		}
		if(!parseAttribute) return;
		this.#configureParse(plugInfo,parseAttribute);
	}
	
	/**
	 * Called when the plugin is disconnected from an element.
	 * Cleans up event listeners, observers, and restores original node/attribute states.
	 *
	 * @param {Object} plugInfo - Information about the plugin disconnection.
	 * @param {HTMLElement} plugInfo.element - The element being disconnected.
	 * @param {Map<string, Object>} plugInfo.attribs - The ScopeDom parsed attributes of the element.
	 */
	onDisconnect(plugInfo){
		let attrib, { element, attribs } = plugInfo;
		if(attribs?.size>0) for(let [n,a] of attribs) if(a.nameParts.length===1 && a.nameParts[0]==='parse'){ attrib=a; break; }
		if(!attrib) return;
		// Remove exclude
		if(this.#childExcludeTextSet.has(element)) this.#childExcludeTextSet.delete(element);
		// Remove event listeners - for element
		if(this.#eventRemovalMap.has(element)){
			let set = this.#eventRemovalMap.get(element);
			for(let removeEvent of set) removeEvent();
			this.#eventRemovalMap.delete(element);
		}
		// Disconnect Mutation Observers - for element
		if(this.#mutationObserverMap.has(element)){
			let mutObs = this.#mutationObserverMap.get(element);
			if(mutObs){ this.#mutationObserverMap.delete(element); mutObs.disconnect(); }
		}
		// Disconnect Intersection Observers - for element
		if(this.#intersectionObserverMap.has(element)){
			let intObs = this.#intersectionObserverMap.get(element);
			if(intObs){ this.#intersectionObserverMap.delete(element); intObs.disconnect(); }
		}
		// Restore original values - for element
		if(!this.#parseStateMap.has(element)) return;
		let state = this.#parseStateMap.get(element);
		let { parseNodes, attributeParseMap, options } = state;
		for(let [node,obj] of parseNodes) this.#revertNodeParse(state,node);
		for(let [e,m] of attributeParseMap) for(let [name,obj] of m) this.#revertAttribParse(state,name);
		let { safeBindOption, htmlBindOption } = options;
		if(safeBindOption || htmlBindOption) this.#revertBindParse(state,element);
		// Remove from Maps & Sets - for element-attribute
		this.#parseStateMap.delete(element);
		// Normalise text nodes
		if(state.normalize) element.normalize = state.normalize;
		element.normalize();
	}
	
	/**
	 * Sets up the parsing configuration for an element based on its attributes.
	 * Handles options like text parsing, tree parsing, once-only execution, attribute binding, and custom regex for expressions.
	 *
	 * @param {Object} plugInfo - Information about the plugin connection.
	 * @param {HTMLElement} plugInfo.element - The element being configured.
	 * @param {Object} plugInfo.elementScopeCtrl - The scope controller for the element.
	 * @param {Object} attrib - The ScopeDom parsed attributes object.
	 * @private
	 */
	#configureParse(plugInfo,attrib){
		let { element, elementScopeCtrl } = plugInfo;
		// Setup Options
		let attributeOptions = this.instance.elementAttribOptionsWithDefaults(element,attrib);
		// Options
		let parseTextOption = this.#getOptionFromAttribute(plugInfo,attrib,attributeOptions,'text',false,true,true); // $parse:text
		let parseTreeOption = this.#getOptionFromAttribute(plugInfo,attrib,attributeOptions,'tree',false,true,true); // $parse:tree
		let onlyOnceOption = this.#getOptionFromAttribute(plugInfo,attrib,attributeOptions,'once',false,true,true); // $parse:once
		let updateScopeEventOption = this.#getOptionFromAttribute(plugInfo,attrib,attributeOptions,'update scope','$update',false,true); // $parse:update-scope='event', $emit('event')
		let updateDomEventOption = this.#getOptionFromAttribute(plugInfo,attrib,attributeOptions,'update dom','$update',false,true); // $parse:update-dom='event', $emitDom('event')
		let errorHandler = this.#getOptionFromAttribute(plugInfo,attrib,attributeOptions,'error','',false,true); // $parse:error
		let allowDomResult = this.#getOptionFromAttribute(plugInfo,attrib,attributeOptions,'allow dom',false,true,true); // $parse:allow-dom
		let visibleOption = this.#getOptionFromAttribute(plugInfo,attrib,attributeOptions,'visible',false,true,true); // $parse:visible
		let defaultTextOption = this.#getOptionFromAttribute(plugInfo,attrib,attributeOptions,'default text','...',false,true); // $parse:default-text
		let safeModeOption = this.#getOptionFromAttribute(plugInfo,attrib,attributeOptions,'safe',false,true,true); // $parse:once
		// Option: $parse:exclude
		let excludeOption = this.#getOptionFromAttribute(plugInfo,attrib,attributeOptions,'exclude',false,true,true); // $parse:exclude
		if(excludeOption.value) this.#childExcludeTextSet.add(element);
		// Option: $parse:exp - Expression Regex
		// Allows customizing the expression delimiter (default is {{exp}})
		let expressionRegex = /(\{\{(.*?)}})/g
		let expressionOption = this.#getOptionFromAttribute(plugInfo,attrib,attributeOptions,'exp',null,false,false); // $parse:exp
		if(expressionOption.value?.length>0){
			// Execute the custom expression format to get the regex pattern string
			let { result:formattedResult } = this.instance.elementExecExp(elementScopeCtrl,expressionOption.value,null,{ silentHas:true, useReturn:true });
			// If the result is cached, use the cached regex
			if(typeof formattedResult==='string' && this.#expressionRegexCache.has(formattedResult)) formattedResult = this.#expressionRegexCache.get(formattedResult);
			if(typeof formattedResult==='string'){
				// Escape regex special characters to use it as a pattern
				var result = formattedResult.replace(/[|\\{}()[\]^$+*?.]/g,'\\$&');
				// Find the position of 'exp' placeholder in the pattern
				let pos1 = result.indexOf('exp');
				if(pos1===-1){ console.warn('pluginParse: invalid format, expecting something like {{exp}}, found',formattedResult,expressionOption?.attribute,element); return false; }
				// Split the pattern into start and end parts around 'exp'
				let start = result.substr(0,pos1);
				let end = result.substr(pos1+3);
				// Reconstruct the regex with the custom delimiters
				expressionRegex = new RegExp('('+start+'(.*?)'+end+')','g');
				// Validate the regex by checking it matches the expected format
				let check = [...this.ScopeDom.regexMatchAll(formattedResult,expressionRegex)];
				if(!check || !check?.[0]){ console.warn('pluginParse: invalid format,',result,'('+start+'(.*?)'+end+')',expressionRegex,check,expressionOption?.attribute,element); return false; }
				if(check?.[0]?.[1]!==formattedResult){ console.warn('pluginParse: invalid format,',expressionRegex,check,expressionOption?.attribute,element); return false; }
				if(check?.[0]?.[2]!=='exp'){ console.warn('pluginParse: invalid format, missing exp,',expressionRegex,check,expressionOption?.attribute,element); return false; }
				// Cache the regex for future use
				this.#expressionRegexCache.set(formattedResult,expressionRegex);
			}
			// If the result is already a RegExp, use it directly
			else if(formattedResult instanceof RegExp) expressionRegex = formattedResult;
			else { console.warn('pluginParse: invalid result, expecting string or regex,',formattedResult,expressionOption?.attribute,element); return false; }
		}
		// Option: $parse:attrib-name - Identifies attributes that should be parsed
		let attributeParseMap = new Map();
		let attributeParseNames = new Set();
		for(let [k,{ optionParts:optParts, value }] of attributeOptions){
			// Only process attributes that start with 'attrib' in their option
			if(optParts.length<2 || optParts[0]!=='attrib') continue;
			let name = optParts.slice(1).join('-');
			attributeParseNames.add(name);
			if(value?.length>0){
				let m = attributeParseMap.get(element) || new Map();
				m.set(name,{ __proto__:null, exec:null, signalObs:null, exp:value, original:null });
				if(!attributeParseMap.has(element)) attributeParseMap.set(element,m);
			}
		}
		// Option: $parse:bind & $parse:bind-html - Parse Bind - Auto-Excludes if no tree or text on same element.
		let safeBindOption = false, htmlBindOption = false;
		let bindSafe = this.#getOptionFromAttribute(plugInfo,attrib,attributeOptions,'bind',false,false,false); // $parse:bind
		let bindHTML = this.#getOptionFromAttribute(plugInfo,attrib,attributeOptions,'bind html',false,false,false); // $parse:bind-html
		if(!(parseTreeOption.value && !parseTreeOption.isDefault) && !(parseTextOption.value && !parseTextOption.isDefault)){
			if(bindSafe.value?.length>0) safeBindOption = { __proto__:null, exec:null, signalObs:null, exp:bindSafe.value, original:element.textContent, ready:false };
			else if(bindHTML.value?.length>0) htmlBindOption = { __proto__:null, exec:null, signalObs:null, exp:bindHTML.value, original:element.innerHTML, ready:false };
			if(safeBindOption || htmlBindOption) this.#childExcludeTextSet.add(element);
		}
		// State
		let state = { __proto__:null,
			signalCtrl: elementScopeCtrl.ctrl.signalCtrl,
			element, normalize:null, parseNodes:new Map(), attributeParseNames, attributeParseMap, nodesPending:false, parsePending:false, isVisible:false,
			options:{ __proto__:null,
				parseTreeOption:parseTreeOption.value, parseTextOption:parseTextOption.value, onlyOnceOption:onlyOnceOption.value, updateScopeEventOption:updateScopeEventOption.value, updateDomEventOption:updateDomEventOption.value,
				errorHandler:errorHandler.value, allowDomResult:allowDomResult.value, onVisible:visibleOption.value, defaultTextOption:defaultTextOption.value,
				excludeOption:excludeOption.value, expressionRegex, safeBindOption, htmlBindOption, safeMode:safeModeOption.value
			}
		};
		this.#parseStateMap.set(element,state);
		// Disable normalize
		if(!state.normalize){
			state.normalize = element.normalize;
			element.normalize = this.#noopNormalize;
		}
		// Listen
		let executeParseTrigger = this.#runParseExpressions.bind(this,state);
		if(updateScopeEventOption.value?.length>0){ // $parse:update='event', $emit('event')
			this.#registerEventRemoval(element,elementScopeCtrl.ctrl.$on(updateScopeEventOption.value,executeParseTrigger,{ __proto__:null, capture:false, passive:true },true));
		}
		if(updateDomEventOption.value?.length>0){ // $parse:update-dom='event', $emitDom('event')
			this.#registerEventRemoval(element,elementScopeCtrl.$onDom(updateDomEventOption.value,executeParseTrigger,{ __proto__:null, capture:true, passive:true },true));
		}
		// Add $parse() to element & element context
		elementScopeCtrl.execContext.$parse = element.$parse = executeParseTrigger;
		// Continue when ready
		this.instance.onReady(function onReadyPluginParse(){
			// Find & watch targets
			this.#discoverParseTargets(state);
			// Observe later nodes
			this.#initializeMutationObserver(state);
			// Observe visability
			if(visibleOption.value) this.#initializeIntersectionObserver(state);
			// Run first parse
			this.#runParseExpressions(state);
			// If more parsing is needed
			if(state.nodesPending) this.#safelyScanAndParse(state);
		}.bind(this),false);
	}
	
	/**
	 * Retrieves a specific option from the element's attribute options.
	 *
	 * @param {Object} plugInfo - Information about the plugin connection.
	 * @param {HTMLElement} plugInfo.elementScopeCtrl - The scope controller for the element.
	 * @param {Object} attrib - The ScopeDom parsed attributes object.
	 * @param {Object} attributeOptions - The ScopeDom parsed attribute options Map.
	 * @param {string} optName - The name of the option to retrieve.
	 * @param {*} [defaultValue=null] - The default value if the option is not found.
	 * @param {boolean} [trueOnEmpty=false] - If true, treats empty or null values as true.
	 * @param {boolean} [runExp=false] - If true, executes the option value as an expression.
	 * @returns {Object} An object containing the resolved value, raw value, and other metadata.
	 * @private
	 */
	#getOptionFromAttribute(plugInfo,attrib,attributeOptions,optName,defaultValue=null,trueOnEmpty=false,runExp=false){
		let { instance } = this;
		let { elementScopeCtrl } = plugInfo;
		let { isDefault, attribute, nameKey, nameParts, value } = attrib;
		let optionValue = defaultValue, option = attributeOptions.get(optName)
		if(trueOnEmpty && (option?.value==='' || option?.value===null)) optionValue = true;
		else if(runExp && option?.value?.length>0){
			let { result } = instance.elementExecExp(elementScopeCtrl,option.value,null,{ silentHas:true, useReturn:true });
			if(typeof result!==void 0) optionValue = result;
		}
		else if(!runExp && option?.value?.length>0) optionValue = option.value;
		return { __proto__:null, value:optionValue, raw:option?.value, attribOption:option, isDefault };
	}
	
	/**
	 * Disables the normalize method on elements.
	 * Logs a warning when called to inform developers that normalize is disabled.
	 * @private
	 */
	#noopNormalize(){ console.warn('This element has .normalize disabled while parse is being used.'); };
	
	/**
	 * Sets up a MutationObserver to watch for changes in the element's subtree.
	 * Useful for detecting added/removed nodes that might need parsing.
	 *
	 * @param {Object} state - The current parsing state for the element.
	 * @private
	 */
	#initializeMutationObserver(state){
		let { element, parseNodes, options } = state;
		let { safeBindOption, htmlBindOption } = options;
		if(safeBindOption || htmlBindOption) return;
		if(this.#mutationObserverMap.has(element)) return;
		let mutObs=new MutationObserver(function pluginParseMutationObserver(muts){
			let needsRescan = false;
			for(let mutation of muts){
				for(let e of mutation.addedNodes){
					if((e.nodeType!==textNodeType && e.nodeType!==elementNodeType) || e.shadowRoot || e.nodeName==='TEMPLATE' || e.nodeName==='SCRIPT' || e.nodeName==='STYLE') continue;
					needsRescan = true;
				}
				for(let e of mutation.removedNodes){
					if(e.nodeType===textNodeType && this.#parsedTextNodesSet.has(e) && parseNodes.has(e)) this.#revertNodeParse(state,e);
					if(this.#childExcludeTextSet.has(e)) this.#childExcludeTextSet.delete(e);
				}
			}
			if(needsRescan) this.#safelyScanAndParse(state);
		}.bind(this));
		// Observe changes in the subtree if tree parsing is enabled
		mutObs.observe(element,{ __proto__:null, subtree:!!options.parseTreeOption, childList:true, attributes:false });
		this.#mutationObserverMap.set(element,mutObs);
	}
	
	/**
	 * Sets up an IntersectionObserver to trigger parsing when the element becomes visible.
	 *
	 * @param {Object} state - The current parsing state for the element.
	 * @private
	 */
	#initializeIntersectionObserver(state){
		let { element, options } = state;
		let { onVisibleOption } = options;
		if(!onVisibleOption || this.#intersectionObserverMap.has(element)) return;
		let fn = this.#runParseExpressions.bind(this,state);
		let intObs=new IntersectionObserver(function pluginParseIntersectionObserver(ints){
			let needsRescan=false, previousVisibilityState=state.isVisible;
			for(let intersection of ints){
				if(intersection.intersectionRatio>0){ if(!previousVisibilityState){ state.isVisible=true; needsRescan=true; } }
				else { if(previousVisibilityState){ state.isVisible=false; } }
			}
			if(needsRescan) this.ScopeDom.animFrameHelper.onceRAF(state.element,'pluginParse-onVisible',fn);
		}.bind(this),{ __proto__:null, threshold:[0,0.05,0.5,0.95,1], rootMargin:"10px", });
		intObs.observe(element);
		this.#intersectionObserverMap.set(element,intObs);
	}
	
	/**
	 * Safely triggers a parsing pass.
	 * It scans for new targets and runs expressions, ensuring that if nodes are pending (due to document loading), it schedules a follow-up check.
	 *
	 * @param {Object} state - The current parsing state.
	 * @private
	 */
	#safelyScanAndParse(state){
		this.#discoverParseTargets(state);
		if(!state.parsePending && !state.nodesPending) return; // Helps prevent infinite-check
		state.parsePending = false;
		this.#runParseExpressions(state);
		// If document is still loading & there's an element mid-dom-construction
		if(state.nodesPending) this.ScopeDom.animFrameHelper.onceRAF(state.element,'pluginParse-nodesPending',this.#safelyScanAndParse.bind(this,state));
		state.nodesPending = false;
	}
	
	/**
	 * Registers an event removal function for an element.
	 *
	 * @param {HTMLElement} element - The element to track.
	 * @param {Function} removeEvent - The function to remove the event listener.
	 * @private
	 */
	#registerEventRemoval(element,removeEvent){
		if(!this.#eventRemovalMap.has(element)) this.#eventRemovalMap.set(element,new Set());
		this.#eventRemovalMap.get(element).add(removeEvent);
	}
	
	/**
	 * Scans the element for targets and initiates the parsing process.
	 *
	 * @param {Object} state - The current parsing state.
	 * @private
	 */
	#discoverParseTargets(state){
		let targetNodes = this.#locateParseTargets(state.element,state);
		this.#parseTargets(state,targetNodes);
	}
	
	/**
	 * Recursively finds elements and attributes that need parsing.
	 *
	 * @param {Node} targetNode - The target node to start searching from.
	 * @param {Object} state - The current parsing state.
	 * @param {boolean} [isRecursive=false] - Search child nodes recursively.
	 * @returns {Object} An object containing sets of nodes and attributes to be parsed.
	 * @private
	 */
	#locateParseTargets(targetNode,state,isRecursive=false){
		let { parseNodes, attributeParseNames, attributeParseMap, options } = state;
		let { parseTreeOption, parseTextOption, expressionRegex, safeBindOption, htmlBindOption } = options;
		let targetNodes = new Set(), targetAttribs = new Set();
		if(parseTreeOption || parseTextOption){
			for(let childElement of targetNode.childNodes){
				if(this.instance.isElementIgnored(childElement,false)) continue; // $ignore
				if(childElement.nodeType!==elementNodeType && childElement.nodeType!==textNodeType) continue;
				if(childElement.shadowRoot || childElement.nodeName==='TEMPLATE' || childElement.nodeName==='SCRIPT' || childElement.nodeName==='STYLE') continue;
				if(parseTextOption && childElement.nodeType===textNodeType){
					if(parseNodes.has(childElement) || this.#parsedTextNodesSet.has(childElement)) continue;
					if(!this.ScopeDom.isElementLoaded(childElement)){ state.nodesPending=true; continue; }
					let hasExpressionMatch = this.ScopeDom.regexTest(childElement.data,expressionRegex);
					if(hasExpressionMatch){
						targetNodes.add(childElement);
						state.parsePending = true;
					}
				}
				else if(parseTreeOption && childElement?.childNodes?.length>0){
					if(this.#childExcludeTextSet.has(childElement)) continue;
					// If element has $parse:exclude
					if(childElement.attributes?.length>0){
						let allElemAttribs = this.instance.elementAttribs(childElement,true,false), foundExclude = false;
						if(allElemAttribs) for(let [attribName,attrib] of allElemAttribs){
							let { nameParts } = attrib;
							if(nameParts.length!==1 || nameParts[0]!=='parse') continue;
							let opts = this.instance.elementAttribOptionsWithDefaults(childElement,attrib,true,false);
							if(opts.has('exclude') && opts.get('exclude').value===''){
								this.#childExcludeTextSet.add(childElement);
								foundExclude = true;
								break;
							}
						}
						if(foundExclude) continue;
					}
					// Recursively search child nodes for parsing targets
					let { targetNodes:childNodes, targetAttribs:childAttribs } = this.#locateParseTargets(childElement,state,isRecursive);
					// Merge results
					if(childNodes.size>0) targetNodes = targetNodes.union ? targetNodes.union(childNodes) : new Set([...targetNodes,...childNodes]);
					if(childAttribs.size>0) targetAttribs = targetAttribs.union ? targetAttribs.union(childAttribs) : new Set([...targetAttribs,...childAttribs]);
				}
			}
		}
		if(!isRecursive){
			if(attributeParseNames.size>0){
				if(!this.ScopeDom.isElementLoaded(targetNode)) state.nodesPending=true;
				for(let { name, value } of targetNode.attributes){
					if(!attributeParseNames.has(name) || !this.ScopeDom.regexTest(value,expressionRegex)) continue;
					if(attributeParseMap.get(targetNode)?.has(name)) continue;
					targetAttribs.add({ __proto__:null, element:targetNode, name, value });
					state.parsePending = true;
				}
			}
			if(safeBindOption && !safeBindOption.ready){
				if(!this.ScopeDom.isElementLoaded(targetNode)) state.nodesPending=true;
				else { safeBindOption.ready=true; state.parsePending=true; }
			}
			else if(htmlBindOption && !htmlBindOption.ready){
				if(!this.ScopeDom.isElementLoaded(targetNode)) state.nodesPending=true;
				else { htmlBindOption.ready=true; state.parsePending=true; }
			}
		}
		return { targetNodes, targetAttribs };
	}
	
	/**
	 * Matches expressions in a string using a regex pattern.
	 * Extracts the outer expression (including delimiters) and inner expression (without delimiters).
	 * @param {string} str - The string to search for expressions.
	 * @param {RegExp} regex - The regex pattern to match expressions.
	 * @returns {Array} An array of match objects, each containing:
	 *   - expOuter: The full expression including delimiters
	 *   - expInner: The expression content without delimiters
	 *   - regexIndex: The starting index of the match in the string
	 * @private
	 */
	#extractRegexMatches(str,regex){
		let match, matches=[]; regex.lastIndex=0;
		while(match=regex.exec(str)) matches.push({ expOuter:match[1], expInner:match[2], regexIndex:match.index });
		return matches;
	}
	
	/**
	 * Performs the actual parsing of the identified targets (text nodes and attributes).
	 *
	 * @param {Object} state - The current parsing state.
	 * @param {Object} targetNodes - The targets to be parsed (nodes and attributes).
	 * @private
	 */
	#parseTargets(state,targetNodes){
		let { parseNodes, attributeParseMap, options } = state;
		let { expressionRegex } = options;
		let { targetNodes:pendingTargetNodes, targetAttribs:pendingTargetAttribs } = targetNodes;
		// Parse text nodes
		if(pendingTargetNodes.size>0){
			for(let e of pendingTargetNodes){
				// Extract matched expressions from text node using regex
				let nodeText=e.data, nodeTextLen=nodeText.length, matches=this.#extractRegexMatches(nodeText,expressionRegex), index=0, targetNodes=[];
				for(let { expOuter, expInner, regexIndex } of matches){
					let parseNode, start=index, pos=regexIndex, end=regexIndex+expOuter.length;
					index = end;
					// If text node is only expression, re-use same node (no splitting needed)
					if(start===0 && pos===0 && index===nodeTextLen) parseNode = e;
					// Otherwise split into multiple nodes (before text, expression, after text)
					else {
						let prefixString = nodeText.substr(start,pos-start);
						if(prefixString.length>0) targetNodes.push(document.createTextNode(prefixString));
						parseNode = document.createTextNode(expOuter);
						targetNodes.push(parseNode);
					}
					parseNodes.set(parseNode,{ __proto__:null, node:parseNode, exec:null, signalObs:null, exp:expInner, original:expOuter, anchor:null, updateIndex:0, lastResult:expOuter });
					this.#parsedTextNodesSet.add(parseNode);
				}
				if(targetNodes.length>0){
					if(index<nodeTextLen) targetNodes.push(document.createTextNode(nodeText.substr(index)));
					const fragment = document.createDocumentFragment();
					for(let n of targetNodes){
						fragment.appendChild(n);
						this.instance.elementScopeSetAlias(n,e);
					}
					e.replaceWith(fragment);
				}
			}
		}
		// Parse attribute values
		if(pendingTargetAttribs.size>0){
			for(let { element:e, name, value:nodeText } of pendingTargetAttribs){
				// Parse attribute values using regex matching
				let matches=this.#extractRegexMatches(nodeText,expressionRegex), index=0, expressionArray=[];
				for(let { expOuter, expInner, regexIndex } of matches){
					let start=index, pos=regexIndex, end=regexIndex+expOuter.length;
					index = end;
					let prefixString = nodeText.substr(start,pos-start);
					if(prefixString.length>0) expressionArray.push(JSON.stringify(prefixString));
					expressionArray.push('('+expInner+')');
				}
				if(index<nodeText.length) expressionArray.push(JSON.stringify(nodeText.substr(index)));
				if(!attributeParseMap.has(e)) attributeParseMap.set(e,new Map());
				let exp, attribMap = attributeParseMap.get(e);
				if(expressionArray.length===1) exp = expressionArray[0];
				else exp = `[${expressionArray.join(',')}].join('')`;
				if(!attribMap.has(name)) attribMap.set(name,{ __proto__:null, exec:null, signalObs:null, exp, original:nodeText, updateIndex:0 });
			}
		}
	}
	
	/**
	 * Reverts a parsed text node back to its original content.
	 * Used during cleanup when the element is disconnected.
	 *
	 * @param {Object} state - The current parsing state.
	 * @param {Text} node - The text node to revert.
	 * @private
	 */
	#revertNodeParse(state,node){
		let { parseNodes } = state;
		let obj = parseNodes.get(node);
		if(obj){
			if(obj.skipUndo){ delete obj.skipUndo; return; }
			if(obj.anchor && obj.anchor.isConnected) return;
			node.data = obj.original;
			obj.lastResult = obj.original;
			if(obj.anchor && obj.anchor.parentNode) obj.anchor.remove();
			obj.signalObs?.clear(); obj.signalObs = obj.exec = null;
		}
		if(this.#parsedTextNodesSet.has(node)) this.#parsedTextNodesSet.delete(node);
		parseNodes.delete(node);
	}
	
	/**
	 * Reverts a parsed attribute back to its original value.
	 * Used during cleanup when the element is disconnected.
	 *
	 * @param {Object} state - The current parsing state.
	 * @param {string} name - The attribute name to revert.
	 * @private
	 */
	#revertAttribParse(state,name){
		let { element, attributeParseMap } = state;
		let obj = attributeParseMap.get(element)?.get(name);
		if(obj && (obj.original===void 0 || obj.original===null)) element.removeAttribute(name);
		else if(obj) element.setAttribute(name,obj.original);
		if(obj){
			attributeParseMap.get(element)?.delete(name);
			obj.signalObs?.clear(); obj.signalObs = obj.exec = null;
		}
	}
	
	/**
	 * Reverts a parsed binding back to its original content.
	 * Used during cleanup when the element is disconnected.
	 *
	 * @param {Object} state - The current parsing state.
	 * @param {HTMLElement} element - The element to revert.
	 * @private
	 */
	#revertBindParse(state,element){
		let { safeBindOption, htmlBindOption } = state.options;
		if(htmlBindOption){
			element.innerHTML = htmlBindOption.original;
			htmlBindOption.signalObs?.clear(); htmlBindOption.signalObs = htmlBindOption.exec = null;
		}
		else if(safeBindOption){
			element.textContent = safeBindOption.original;
			safeBindOption.signalObs?.clear(); safeBindOption.signalObs = safeBindOption.exec = null;
		}
	}
	
	/**
	 * Executes an expression in the context of a node.
	 * Creates a signal observer and wraps the run function for signal tracking.
	 *
	 * @param {HTMLElement} element - The root element for the expression context.
	 * @param {Text} node - The text node to execute the expression in.
	 * @param {string} exp - The expression to execute.
	 * @param {Object} signalObs - The signal observer to wrap the run function.
	 * @returns {Object} The execution result.
	 * @private
	 */
	#executeExpression(element,node,exp,signalObs){
		let eCtrl = this.instance.elementScopeCtrl(node);
		let exec = this.instance.elementExecExp(eCtrl,exp,{ $node:node, $expression:exp, $parseRoot:element },{ silentHas:true, useReturn:true, run:false });
		if(signalObs) exec.runFn = signalObs.wrapRecorder(exec.runFn);
		return exec;
	}
	
	/**
	 * Executes the parsing logic for all identified text nodes, attributes, and bindings.
	 *
	 * @param {Object} state - The current parsing state.
	 * @private
	 */
	#runParseExpressions(state){
		let { signalCtrl, element, parseNodes, attributeParseMap, isVisible, options } = state;
		let { onlyOnceOption, safeBindOption, htmlBindOption, onVisibleOption } = options;
		let self = this;
		// Text Nodes
		for(let [n,obj] of parseNodes){
			let result, { node, exp, exec, signalObs, comment, updateIndex } = obj;
			if(!node.isConnected && !(comment && comment.isConnected)){ this.#revertNodeParse(state,node); continue; }
			if(exec && onlyOnceOption) continue;
			if(onVisibleOption && !isVisible){ if(updateIndex===0) result=options.defaultTextOption; else continue; }
			else{
				if(!exec){
					signalObs = obj.signalObs = signalCtrl.createObserver();
					exec = obj.exec = this.#executeExpression(element,node,exp,signalObs);
					signalObs.addListener(function parseTextNode_signalObserver(){
						let updateIndex = obj.updateIndex;
						self.ScopeDom.animFrameHelper.onceRAF(node,signalObs,function parseTextNode_signalObserver_RAF(){
							if(obj.updateIndex!==updateIndex) return;
							signalObs.clearSignals();
							self.#updateTextNode(node,exec.runFn(),obj,state,updateIndex,signalObs);
						});
					});
				}
				result = exec.runFn();
			}
			this.#updateTextNode(node,result,obj,state,updateIndex,signalObs);
		}
		// Element Attributes
		for(let [node,attribMap] of attributeParseMap){
			if(!node.isConnected){ for(let [name,obj] of attribMap){ this.#revertAttribParse(state,name); } continue; }
			for(let [name,obj] of attribMap){
				let { exp, exec, signalObs, updateIndex } = obj;
				if(exec && onlyOnceOption) continue;
				if(onVisibleOption && !isVisible) continue;
				if(!exec){
					signalObs = obj.signalObs = signalCtrl.createObserver();
					exec = obj.exec = this.#executeExpression(element,node,exp,signalObs);
					signalObs.addListener(function parseAttribs_signalObserver(){
						let updateIndex = obj.updateIndex;
						self.ScopeDom.animFrameHelper.onceRAF(node,signalObs,function parseAttribs_signalObserver_RAF(){
							if(obj.updateIndex!==updateIndex) return;
							signalObs.clearSignals();
							self.#updateAttribute(node,name,exec.runFn(),obj,state,updateIndex,signalObs);
						});
					});
				}
				this.#updateAttribute(node,name,exec.runFn(),obj,state,updateIndex,signalObs);
			}
		}
		// Bind-Safe attribute
		if(safeBindOption && safeBindOption.ready){
			for(let { exec, exp, signalObs, updateIndex } of [safeBindOption]){
				if(exec && onlyOnceOption) continue;
				if(onVisibleOption && !isVisible) continue;
				if(!exec){
					signalObs = safeBindOption.signalObs = signalCtrl.createObserver();
					exec = safeBindOption.exec = this.#executeExpression(element,element,exp,signalObs);
					signalObs.addListener(function parseBindSafe_signalObserver(){
						let updateIndex = safeBindOption.updateIndex;
						self.ScopeDom.animFrameHelper.onceRAF(element,signalObs,function parseBindSafe_signalObserver_RAF(){
							if(safeBindOption.updateIndex!==updateIndex) return;
							signalObs.clearSignals();
							self.#updateBind(element,false,exec.runFn(),safeBindOption,state,updateIndex,signalObs);
						});
					});
				}
				this.#updateBind(element,false,exec.runFn(),safeBindOption,state,updateIndex,signalObs);
			}
		}
		// Bind-HTML attribute
		else if(htmlBindOption && htmlBindOption.ready){
			for(let { exec, exp, signalObs, updateIndex } of [htmlBindOption]){
				if(exec && onlyOnceOption) continue;
				if(onVisibleOption && !isVisible) continue;
				if(!exec){
					signalObs = htmlBindOption.signalObs = signalCtrl.createObserver();
					exec = htmlBindOption.exec = this.#executeExpression(element,element,exp,signalObs);
					signalObs.addListener(function parseBindHTML_signalObserver(){
						let updateIndex = htmlBindOption.updateIndex;
						self.ScopeDom.animFrameHelper.onceRAF(element,signalObs,function parseBindHTML_signalObserver_RAF(){
							if(htmlBindOption.updateIndex!==updateIndex) return;
							signalObs.clearSignals();
							self.#updateBind(element,true,exec.runFn(),htmlBindOption,state,updateIndex,signalObs);
						});
					});
				}
				this.#updateBind(element,true,exec.runFn(),htmlBindOption,state,updateIndex,signalObs);
			}
		}
	}
	
	/**
	 * Updates the content of a text node with the result of an expression.
	 *
	 * @param {Text} node - The text node to update.
	 * @param {*} result - The result of the expression execution.
	 * @param {Object} obj - The parsing object for this node.
	 * @param {Object} state - The current parsing state.
	 * @param {number} updateIndex - The current update iteration index.
	 * @param {Object} signalObs - The signal observer for tracking updates.
	 * @private
	 */
	#updateTextNode(node,result,obj,state,updateIndex,signalObs){
		let { options } = state;
		if(result instanceof Promise){
			if(updateIndex===0){
				this.#updateTextNode(node,options.defaultTextOption,obj,state,updateIndex,signalObs);
				updateIndex = obj.updateIndex;
			}
			let onSuccess = (result)=>this.#updateTextNode(node,result,obj,state,updateIndex,signalObs);
			let onError = ()=>this.#updateTextNode(node,options.onError,obj,state,updateIndex,signalObs);
			this.ScopeDom.animFrameHelper.promiseToRAF(result,onSuccess,onError);
			return;
		}
		// Ignore old calls
		if(obj.updateIndex>updateIndex) return;
		obj.updateIndex++;
		// Result Types
		result = this.ScopeDom.resolveSignal(result,signalObs);
		if(result instanceof Error) result = options.onError;
		if(result instanceof Node){
			let validNode = true;
			for(let e=node; e; e=e.parentNode) if(e===result){ validNode=false; break; }
			if(validNode) result = result.textContent;
			else result = options.onError;
		}
		result = (result===null || result===void 0) ? '' : ''+result;
		// Unchanged result
		if(obj.lastResult===result) return;
		obj.lastResult = result;
		// If textnode is not visible, some browsers (FF) remove it, so anchor it with comment
		let visible = isTextNodeSolid(result);
		if(!visible && !obj.anchor){
			obj.anchor = document.createComment(' Parse-Anchor: '+obj.original+' '); //obj.anchor.$parseTextNode=node;
			this.instance.elementScopeSetAlias(obj.anchor,node);
			node.parentNode.insertBefore(obj.anchor,node.nextSibling);
		}
		let current = node.data;
		// Prevent recursion
		if(options.safeMode){
			if(result.length>current.length && result.indexOf(current)!==-1){ obj.foundWithin=(obj.foundWithin||0)+1; if(obj.foundWithin>5)return; }
			else obj.foundWithin = 0;
		}
		// Update Result
		if(current!==result) node.data = result;
		if(obj.anchor && (!obj.anchor.isConnected || node.nextSibling!==obj.anchor)){ obj.skipUndo=true; obj.anchor.parentNode.insertBefore(node,obj.anchor); }
	}
	
	/**
	 * Updates an element's attribute with the result of an expression.
	 *
	 * @param {HTMLElement} element - The element to update.
	 * @param {string} attribute - The attribute name.
	 * @param {*} result - The result of the expression execution.
	 * @param {Object} obj - The parsing object for this attribute.
	 * @param {Object} state - The current parsing state.
	 * @param {number} updateIndex - The current update iteration index.
	 * @param {Object} signalObs - The signal observer for tracking updates.
	 * @private
	 */
	#updateAttribute(element,attribute,result,obj,state,updateIndex,signalObs){
		let { options } = state;
		result = this.ScopeDom.resolveSignal(result,signalObs);
		if(result instanceof Promise){
			let onSuccess = (result)=>this.#updateAttribute(element,attribute,result,obj,state,updateIndex,signalObs);
			let onError = ()=>this.#updateAttribute(element,attribute,options.onError,obj,state,updateIndex,signalObs);
			this.ScopeDom.animFrameHelper.promiseToRAF(result,onSuccess,onError);
			return;
		}
		// Ignore old calls
		if(obj.updateIndex>updateIndex) return;
		obj.updateIndex++;
		// Result Types
		if(result instanceof Error) element.setAttribute(attribute,options.onError);
		else if((result===null || result===void 0) && element.hasAttribute(attribute)) element.removeAttribute(attribute);
		else if(result?.length>=0){ result=''+result; if(element.getAttribute(attribute)!==result) element.setAttribute(attribute,result); }
	}
	
	/**
	 * Updates an element's content (innerHTML or textContent) based on a binding.
	 *
	 * @param {HTMLElement} element - The element to update.
	 * @
	 * @param {boolean} isHTML - If binding is for HTML content.
	 * @param {*} result - The result of the expression execution.
	 * @param {Object} obj - The parsing object for this binding.
	 * @param {Object} state - The current parsing state.
	 * @param {number} updateIndex - The current update iteration index.
	 * @param {Object} signalObs - The signal observer for tracking updates.
	 * @private
	 */
	#updateBind(element,isHTML,result,obj,state,updateIndex,signalObs){
		let { options } = state;
		if(result instanceof Promise){
			let onSuccess = (result)=>this.#updateBind(element,isHTML,result,obj,state,updateIndex,signalObs);
			let onError = ()=>this.#updateBind(element,isHTML,options.onError,obj,state,updateIndex,signalObs);
			this.ScopeDom.animFrameHelper.promiseToRAF(result,onSuccess,onError);
			return;
		}
		// Ignore old calls
		if(obj.updateIndex>updateIndex) return;
		obj.updateIndex++;
		// Result Types
		result = this.ScopeDom.resolveSignal(result,signalObs);
		if(result instanceof Error) result = options.onError;
		if(result instanceof NodeList){ let e=document.createDocumentFragment(); for(let n of [...result])e.appendChild(n); result=e; }
		else if(result instanceof HTMLCollection){ let e=document.createDocumentFragment(); for(let n of [...result])e.appendChild(n); result=e; }
		if(result instanceof Node){
			let validNode = true;
			for(let e=element; e; e=e.parentNode) if(e===result){ validNode=false; break; }
			if(!validNode) result = options.onError;
			else if(!options.allowDomResult) result = isHTML?(result.innerHTML||result.textContent):result.textContent;
			else { element.textContent=''; element.appendChild(result); return; }
		}
		result = (result===null || result===void 0) ? '' : ''+result;
		let current = isHTML ? element.innerHTML : element.textContent;
		// Prevent recursion
		if(options.safeMode){
			if(result.length>current.length && result.indexOf(current)!==-1){ obj.foundWithin=(obj.foundWithin||0)+1; if(obj.foundWithin>5)return; }
			else obj.foundWithin = 0;
		}
		// Update Result
		if(current!==result){
			if(isHTML && hasSetHTMLSupport) element.setHTML(result);
			else if(isHTML) element.innerHTML = result;
			else element.textContent = result;
		}
	}
	
}

let win = typeof window!=='undefined' && window;
if(win) win.ScopeDom?.pluginAdd?.(pluginParse) || ((win.ScopeDomPlugins=win.ScopeDomPlugins||{}).pluginParse=pluginParse);
