
import ScopeDom from "./scopedom.js";

import { pluginCloak } from "./plugins/cloak.js";
import { pluginIf } from "./plugins/if.js";
import { pluginParse } from "./plugins/parse.js";
import { pluginRepeat } from "./plugins/repeat.js";
import { pluginPipeExp } from "./plugins/pipe-expression.js";

Object.assign(ScopeDom,{
	pluginCloak, pluginIf, pluginParse, pluginRepeat, pluginPipeExp
});

export default ScopeDom;
