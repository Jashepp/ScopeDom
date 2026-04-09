
let isWatch = process.env.ROLLUP_WATCH==='true' || process.env.npm_lifecycle_event?.indexOf('watch')!==-1;

let defaults = {
	treeshake: false,
	cache: true,
	input: {},
	output: {
		sourcemap: true,
		format: "iife",
	},
	watch: !!isWatch,
};
let banner = ``;
let footer = `\nif(typeof ScopeDom!=='undefined') Object.freeze(ScopeDom);`;

let pluginUMD = { format:"umd", name:"ScopeDomPlugins", extend:true, exports:"named", banner };
let pluginESM = { format:"es", banner };

let files = {
	core: "./src/scopedom.js",
	bundle: "./src/bundle.js",
	plugins: {
		"cloak-simple": "./src/plugins/cloak-simple.js",
		cloak:	"./src/plugins/cloak.js",
		parse:	"./src/plugins/parse.js",
		if:		"./src/plugins/if.js",
		repeat:	"./src/plugins/repeat.js",
	},
};

let coreUMD = { input:files.core, output:{ file:"./dist/scopedom.umd.js", format:"umd", name:"ScopeDom", exports:"default", extend:true, banner, footer } };
let coreESM = { input:files.core, output:{ file:"./dist/scopedom.js", format:"es", banner, footer } };

let bundleUMD = { input:files.bundle, output:{ file:"./dist/scopedom.bundle.umd.js", format:"umd", name:"ScopeDom", exports:"default", extend:true, banner, footer } };
let bundleESM = { input:files.bundle, output:{ file:"./dist/scopedom.bundle.js", format:"es", banner, footer } };

let config = [coreUMD,coreESM,bundleUMD,bundleESM];

// Plugins
for(let [key,value] of Object.entries(files.plugins)){
	config.push({ input:value, output:{ file:`./dist/plugins/${key}.umd.js`, ...pluginUMD } });
	config.push({ input:value, output:{ file:`./dist/plugins/${key}.js`, ...pluginESM } });
}

for(let fileConfig of config){
	Object.assign({},defaults,fileConfig);
	if(fileConfig.output) fileConfig.output = Object.assign({},defaults.output,fileConfig.output);
}

export default config;
