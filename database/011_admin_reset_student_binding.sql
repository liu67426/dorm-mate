-- 辅导员为学生更换设备时，只解除旧登录身份。
-- 问卷、组队、邀请、分寝与已发布结果均不删除。
CREATE OR REPLACE FUNCTION public.dorm_admin_reset_student_binding(p_student_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_student public.dorm_students%ROWTYPE;
  v_was_bound boolean;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.dorm_admins WHERE uid = v_uid) THEN
    RAISE EXCEPTION '没有辅导员权限';
  END IF;
  IF p_student_id IS NULL OR length(trim(p_student_id)) = 0 THEN
    RAISE EXCEPTION '缺少学生编号';
  END IF;

  SELECT * INTO v_student
  FROM public.dorm_students
  WHERE id = trim(p_student_id)
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '学生不存在'; END IF;

  v_was_bound := v_student.auth_uid IS NOT NULL;
  IF v_was_bound THEN
    UPDATE public.dorm_students
    SET auth_uid = NULL, bound_at = NULL
    WHERE id = v_student.id;
  END IF;

  INSERT INTO public.dorm_audit_logs(action, uid, entity_id, detail)
  VALUES ('STUDENT_BINDING_RESET', v_uid, v_student.id, jsonb_build_object(
    'wasBound', v_was_bound,
    'surveyCompleted', v_student.survey_completed
  ));

  RETURN jsonb_build_object(
    'studentId', v_student.id,
    'name', v_student.name,
    'wasBound', v_was_bound,
    'surveyCompleted', v_student.survey_completed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dorm_admin_reset_student_binding(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dorm_admin_reset_student_binding(text) TO authenticated, service_role;
