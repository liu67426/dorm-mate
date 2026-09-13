-- 只向当前登录学生返回本人填写的前三项匹配重点，并且必须已有已发布住宿结果。
CREATE OR REPLACE FUNCTION public.dorm_student_priorities()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_answers jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;

  SELECT survey.answers INTO v_answers
  FROM public.dorm_students AS student
  JOIN public.dorm_surveys AS survey ON survey.student_id = student.id
  JOIN public.dorm_assignments AS assignment ON assignment.student_id = student.id
  JOIN public.dorm_allocation_runs AS run ON run.id = assignment.run_id AND run.status = 'published'
  WHERE student.auth_uid = v_uid;

  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;

  RETURN jsonb_build_array(
    NULLIF(v_answers->>'priority1', ''),
    NULLIF(v_answers->>'priority2', ''),
    NULLIF(v_answers->>'priority3', '')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dorm_student_priorities() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dorm_student_priorities() TO authenticated, service_role;
