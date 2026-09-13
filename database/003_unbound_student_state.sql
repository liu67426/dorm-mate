-- 尚未核验名单的匿名账号访问学生页时，返回空状态而不是400错误。
-- 这不会放宽名单校验：提交问卷仍必须先通过 dorm_bind_student。

CREATE OR REPLACE FUNCTION public.dorm_student_state()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_student public.dorm_students%ROWTYPE;
  v_group public.dorm_groups%ROWTYPE;
  v_assignment public.dorm_assignments%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT * INTO v_student FROM public.dorm_students WHERE auth_uid = v_uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'student', NULL,
      'surveyCompleted', false,
      'group', NULL,
      'groupMembers', '[]'::jsonb,
      'incomingInvites', '[]'::jsonb,
      'candidates', '[]'::jsonb,
      'assignment', NULL
    );
  END IF;

  IF v_student.group_id IS NOT NULL THEN SELECT * INTO v_group FROM public.dorm_groups WHERE id = v_student.group_id; END IF;
  SELECT * INTO v_assignment FROM public.dorm_assignments WHERE student_id = v_student.id;

  RETURN jsonb_build_object(
    'student', jsonb_build_object('id', v_student.id, 'name', v_student.name, 'classId', v_student.class_id, 'gender', v_student.gender),
    'surveyCompleted', v_student.survey_completed,
    'group', CASE WHEN v_group.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_group.id, 'classId', v_group.class_id, 'memberIds', v_group.member_ids,
      'confirmedIds', v_group.confirmed_ids, 'status', v_group.status,
      'compatibilityScore', COALESCE(v_group.compatibility_score, 0)
    ) END,
    'groupMembers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'confirmed', s.id = ANY(COALESCE(v_group.confirmed_ids, ARRAY[]::text[]))) ORDER BY s.name)
      FROM public.dorm_students s WHERE s.id = ANY(COALESCE(v_group.member_ids, ARRAY[]::text[]))
    ), '[]'::jsonb),
    'incomingInvites', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', i.id, 'groupId', i.group_id, 'fromStudentId', i.from_student_id, 'fromStudentName', COALESCE(sender.name, '同班同学')) ORDER BY i.created_at DESC)
      FROM public.dorm_invitations i LEFT JOIN public.dorm_students sender ON sender.id = i.from_student_id
      WHERE i.to_student_id = v_student.id AND i.status = 'pending'
    ), '[]'::jsonb),
    'candidates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
      FROM public.dorm_students s
      WHERE s.class_id = v_student.class_id AND s.gender = v_student.gender
        AND s.survey_completed = true AND s.group_id IS NULL AND s.id <> v_student.id
    ), '[]'::jsonb),
    'assignment', CASE WHEN v_assignment.student_id IS NULL THEN NULL ELSE jsonb_build_object(
      'roomNumber', v_assignment.room_number,
      'bedNo', v_assignment.bed_no,
      'gender', v_assignment.gender,
      'publishedAt', v_assignment.published_at,
      'availableBeds', (SELECT jsonb_agg(n ORDER BY n) FROM generate_series(1, 4) n WHERE NOT EXISTS (
        SELECT 1 FROM public.dorm_assignments a WHERE a.room_number = v_assignment.room_number AND a.bed_no = n AND a.student_id <> v_student.id
      )),
      'roommates', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', s.name, 'bedNo', a.bed_no) ORDER BY s.name)
        FROM public.dorm_assignments a JOIN public.dorm_students s ON s.id = a.student_id
        WHERE a.room_number = v_assignment.room_number), '[]'::jsonb)
    ) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dorm_student_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dorm_student_state() TO authenticated;
