-- CloudBase 学生使用匿名登录后绑定名单身份，数据库角色为 anon。
-- 函数内部仍通过 auth.uid()、本人学号绑定和已发布寝室三重限制数据范围。
GRANT EXECUTE ON FUNCTION public.dorm_student_match_view() TO anon;
