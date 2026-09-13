// 仅执行已核对并备份的特定撤回脚本，默认预演；不读取或存储密码。
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
const [mode,sqlPath,environment]=process.argv.slice(2);
if(!["preview","commit"].includes(mode)||!sqlPath||!environment)throw new Error("参数：preview或commit 撤回SQL文件 环境ID");
const sql=fs.readFileSync(sqlPath,"utf8");
if(!sql.startsWith("BEGIN;")||!sql.includes("ALLOCATION_PARTIAL_WITHDRAW"))throw new Error("不是已核对的撤回脚本");
const cli=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../node_modules/@cloudbase/cli/bin/tcb");
process.argv=[process.execPath,cli,"db","execute","-e",environment,"--sql",sql+"\n"+(mode==="commit"?"COMMIT;":"ROLLBACK;"),"--json"];
createRequire(import.meta.url)(cli);
