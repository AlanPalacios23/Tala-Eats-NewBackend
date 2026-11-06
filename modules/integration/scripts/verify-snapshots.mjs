import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const base=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const lock=JSON.parse(readFileSync(resolve(base,'modules/integration/source-lock.json'),'utf8'));
if(lock.origins.length!==10)throw Error('M11_MISSING_DOMAIN');
for(const origin of lock.origins){
 const actual=execFileSync('git',['rev-parse','HEAD:'+origin.path],
   {cwd:base,encoding:'utf8'}).trim();
 if(actual!==origin.tree)throw Error('M11_SNAPSHOT_DRIFT:'+origin.id);
 console.log('M11_PIN_PASS',origin.id,origin.domain,actual.slice(0,12));
}
console.log('M11_TEN_IMMUTABLE_MODULE_TREES_VERIFIED');
