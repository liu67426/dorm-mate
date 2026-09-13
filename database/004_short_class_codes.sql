-- 将现有学生记录的班级填写码统一缩短为01—04。
UPDATE public.dorm_students
SET class_code = CASE class_id
  WHEN '1' THEN '01'
  WHEN '2' THEN '02'
  WHEN '3' THEN '03'
  WHEN '4' THEN '04'
  ELSE class_code
END
WHERE class_id IN ('1', '2', '3', '4');
