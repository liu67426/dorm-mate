import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const mode=process.argv[2]||"verify-candidate";
const envId=process.argv[3];
if(!envId || !["verify-candidate","verify-live","deploy"].includes(mode)) throw Error("用法：node scripts/check-group-database.mjs verify-candidate|verify-live|deploy 环境ID");
const migration=fs.readFileSync(path.join(root,"database/012_group_membership_semantics.sql"),"utf8");
const scenarios=fs.readFileSync(path.join(root,"tests/group-database-scenarios.sql"),"utf8");
// 一次请求、同一事务；候选及线上验收都回滚，只有明确 deploy 才提交函数更新。
const sql="BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s';\n"+
  (mode==="verify-live"?"":migration)+
  (mode==="deploy"?"\nSELECT 'GROUP_FUNCTIONS_DEPLOYED' AS result; COMMIT;":"\n"+scenarios+"\nSELECT 'GROUP_SCENARIOS_PASSED_AND_ROLLED_BACK' AS result; ROLLBACK;");
process.argv=[process.execPath,path.join(root,"node_modules/@cloudbase/cli/bin/tcb"),"db","execute","-e",envId,"--sql",sql,"--json"];
createRequire(import.meta.url)(path.join(root,"node_modules/@cloudbase/cli/bin/tcb"));
