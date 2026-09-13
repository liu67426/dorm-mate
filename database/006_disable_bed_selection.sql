-- 最新业务决定：学生端只查看寝室号和室友，不开放在线抢选床位。
-- 保留历史字段以兼容既有数据，但撤销学生账号对选床函数的执行权限。

REVOKE ALL ON FUNCTION public.dorm_choose_bed(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.dorm_choose_bed(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dorm_choose_bed(integer) TO service_role;
