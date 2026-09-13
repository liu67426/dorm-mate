-- 单人可申请加入本班、同性别的2人或3人缺员小组。
-- 申请由目标小组任一现有成员确认，所有操作都通过登录身份再次校验。

CREATE TABLE IF NOT EXISTS public.dorm_join_requests (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES public.dorm_groups(id) ON DELETE CASCADE,
  applicant_student_id text NOT NULL REFERENCES public.dorm_students(id) ON DELETE CASCADE,
  class_id text NOT NULL CHECK (class_id IN ('1', '2', '3', '4')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz
);

CREATE INDEX IF NOT EXISTS dorm_join_requests_group_idx ON public.dorm_join_requests(group_id, status);
CREATE INDEX IF NOT EXISTS dorm_join_requests_applicant_idx ON public.dorm_join_requests(applicant_student_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS dorm_join_requests_pending_unique
  ON public.dorm_join_requests(group_id, applicant_student_id) WHERE status = 'pending';

ALTER TABLE public.dorm_join_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dorm_join_requests FROM anon, authenticated;
GRANT ALL ON public.dorm_join_requests TO service_role;

CREATE OR REPLACE FUNCTION public.dorm_request_join_group(p_group_id text, p_request_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_applicant public.dorm_students%ROWTYPE;
  v_current_group public.dorm_groups%ROWTYPE;
  v_target_group public.dorm_groups%ROWTYPE;
  v_existing_id text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT * INTO v_applicant FROM public.dorm_students WHERE auth_uid = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '当前浏览器未关联学生身份，请重新核验名单'; END IF;
  IF NOT v_applicant.survey_completed THEN RAISE EXCEPTION '请先完成个人问卷'; END IF;

  IF v_applicant.group_id IS NOT NULL THEN
    SELECT * INTO v_current_group FROM public.dorm_groups WHERE id = v_applicant.group_id FOR UPDATE;
    IF FOUND AND cardinality(v_current_group.member_ids) > 1 THEN RAISE EXCEPTION '你已经加入多人小组，不能申请其他小组'; END IF;
  END IF;

  SELECT * INTO v_target_group FROM public.dorm_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND OR v_target_group.status <> 'forming' OR cardinality(v_target_group.member_ids) NOT BETWEEN 2 AND 3 THEN
    RAISE EXCEPTION '该小组已满员或不再接受申请';
  END IF;
  IF v_target_group.id = v_applicant.group_id OR v_target_group.class_id <> v_applicant.class_id THEN
    RAISE EXCEPTION '只能申请加入本班其他小组';
  END IF;
  IF v_applicant.gender IS NULL OR EXISTS (
    SELECT 1 FROM public.dorm_students member
    WHERE member.id = ANY(v_target_group.member_ids) AND member.gender IS DISTINCT FROM v_applicant.gender
  ) THEN RAISE EXCEPTION '只能申请加入同性别小组'; END IF;

  SELECT id INTO v_existing_id FROM public.dorm_join_requests
  WHERE group_id = v_target_group.id AND applicant_student_id = v_applicant.id AND status = 'pending'
  LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'pending', 'requestId', v_existing_id);
  END IF;

  INSERT INTO public.dorm_join_requests(id, group_id, applicant_student_id, class_id)
  VALUES (p_request_id, v_target_group.id, v_applicant.id, v_applicant.class_id);
  INSERT INTO public.dorm_audit_logs(action, uid, entity_id, detail)
  VALUES ('GROUP_JOIN_REQUEST', v_uid, p_request_id, jsonb_build_object('groupId', v_target_group.id));
  RETURN jsonb_build_object('status', 'pending', 'requestId', p_request_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.dorm_respond_join_request(p_request_id text, p_accepted boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_responder public.dorm_students%ROWTYPE;
  v_applicant public.dorm_students%ROWTYPE;
  v_request public.dorm_join_requests%ROWTYPE;
  v_target_group public.dorm_groups%ROWTYPE;
  v_old_group public.dorm_groups%ROWTYPE;
  v_member_ids text[];
  v_confirmed_ids text[];
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT * INTO v_responder FROM public.dorm_students WHERE auth_uid = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '当前浏览器未关联学生身份，请重新核验名单'; END IF;

  SELECT * INTO v_request FROM public.dorm_join_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'pending' THEN RAISE EXCEPTION '加入申请不存在或已经处理'; END IF;
  SELECT * INTO v_target_group FROM public.dorm_groups WHERE id = v_request.group_id FOR UPDATE;
  IF NOT FOUND OR NOT (v_responder.id = ANY(v_target_group.member_ids)) THEN RAISE EXCEPTION '只有该小组现有成员可以处理申请'; END IF;

  IF NOT p_accepted THEN
    UPDATE public.dorm_join_requests SET status = 'declined', responded_at = now() WHERE id = v_request.id;
    INSERT INTO public.dorm_audit_logs(action, uid, entity_id) VALUES ('GROUP_JOIN_DECLINE', v_uid, v_request.id);
    RETURN jsonb_build_object('status', 'declined');
  END IF;

  IF v_target_group.status <> 'forming' OR cardinality(v_target_group.member_ids) >= 4 THEN RAISE EXCEPTION '该小组已满员或不再有效'; END IF;
  SELECT * INTO v_applicant FROM public.dorm_students WHERE id = v_request.applicant_student_id FOR UPDATE;
  IF NOT FOUND OR NOT v_applicant.survey_completed OR v_applicant.class_id <> v_target_group.class_id THEN RAISE EXCEPTION '申请人当前不符合加入条件'; END IF;
  IF v_applicant.gender IS NULL OR EXISTS (
    SELECT 1 FROM public.dorm_students member
    WHERE member.id = ANY(v_target_group.member_ids) AND member.gender IS DISTINCT FROM v_applicant.gender
  ) THEN RAISE EXCEPTION '申请人与小组性别不一致'; END IF;

  IF v_applicant.group_id IS NOT NULL AND v_applicant.group_id <> v_target_group.id THEN
    SELECT * INTO v_old_group FROM public.dorm_groups WHERE id = v_applicant.group_id FOR UPDATE;
    IF FOUND AND (cardinality(v_old_group.member_ids) <> 1 OR v_old_group.member_ids[1] <> v_applicant.id) THEN
      RAISE EXCEPTION '申请人已经加入其他多人小组';
    END IF;
    UPDATE public.dorm_students SET group_id = NULL WHERE id = v_applicant.id;
    IF v_old_group.id IS NOT NULL THEN DELETE FROM public.dorm_groups WHERE id = v_old_group.id; END IF;
  END IF;

  v_member_ids := array_append(v_target_group.member_ids, v_applicant.id);
  v_confirmed_ids := CASE
    WHEN v_applicant.id = ANY(COALESCE(v_target_group.confirmed_ids, ARRAY[]::text[])) THEN v_target_group.confirmed_ids
    ELSE array_append(COALESCE(v_target_group.confirmed_ids, ARRAY[]::text[]), v_applicant.id)
  END;
  UPDATE public.dorm_groups
  SET member_ids = v_member_ids,
      confirmed_ids = v_confirmed_ids,
      status = CASE WHEN cardinality(v_member_ids) = 4 THEN 'complete' ELSE 'forming' END,
      updated_at = now()
  WHERE id = v_target_group.id;
  UPDATE public.dorm_students SET group_id = v_target_group.id WHERE id = v_applicant.id;
  UPDATE public.dorm_join_requests SET status = 'accepted', responded_at = now() WHERE id = v_request.id;
  UPDATE public.dorm_join_requests SET status = 'cancelled', responded_at = now()
    WHERE applicant_student_id = v_applicant.id AND status = 'pending' AND id <> v_request.id;
  UPDATE public.dorm_invitations SET status = 'cancelled', responded_at = now()
    WHERE to_student_id = v_applicant.id AND status = 'pending';
  IF cardinality(v_member_ids) = 4 THEN
    UPDATE public.dorm_join_requests SET status = 'cancelled', responded_at = now()
      WHERE group_id = v_target_group.id AND status = 'pending';
    UPDATE public.dorm_invitations SET status = 'cancelled', responded_at = now()
      WHERE group_id = v_target_group.id AND status = 'pending';
  END IF;
  INSERT INTO public.dorm_audit_logs(action, uid, entity_id, detail)
  VALUES ('GROUP_JOIN_ACCEPT', v_uid, v_request.id, jsonb_build_object('groupId', v_target_group.id, 'applicantId', v_applicant.id));
  RETURN jsonb_build_object('status', 'accepted', 'groupId', v_target_group.id, 'memberCount', cardinality(v_member_ids));
END;
$$;

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
      'incomingJoinRequests', '[]'::jsonb,
      'joinableGroups', '[]'::jsonb,
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
    'incomingJoinRequests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', request.id, 'applicantStudentId', applicant.id, 'applicantName', applicant.name) ORDER BY request.created_at DESC)
      FROM public.dorm_join_requests request
      JOIN public.dorm_students applicant ON applicant.id = request.applicant_student_id
      WHERE request.group_id = v_student.group_id AND request.status = 'pending'
        AND v_group.id IS NOT NULL AND cardinality(v_group.member_ids) < 4
    ), '[]'::jsonb),
    'joinableGroups', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', candidate_group.id,
        'memberCount', cardinality(candidate_group.member_ids),
        'memberNames', COALESCE((SELECT jsonb_agg(member.name ORDER BY member.name) FROM public.dorm_students member WHERE member.id = ANY(candidate_group.member_ids)), '[]'::jsonb),
        'requested', EXISTS (SELECT 1 FROM public.dorm_join_requests request WHERE request.group_id = candidate_group.id AND request.applicant_student_id = v_student.id AND request.status = 'pending')
      ) ORDER BY cardinality(candidate_group.member_ids) DESC, candidate_group.created_at)
      FROM public.dorm_groups candidate_group
      WHERE v_student.survey_completed = true
        AND (v_group.id IS NULL OR cardinality(v_group.member_ids) <= 1)
        AND candidate_group.id IS DISTINCT FROM v_student.group_id
        AND candidate_group.class_id = v_student.class_id
        AND candidate_group.status = 'forming'
        AND cardinality(candidate_group.member_ids) BETWEEN 2 AND 3
        AND NOT EXISTS (
          SELECT 1 FROM public.dorm_students member
          WHERE member.id = ANY(candidate_group.member_ids) AND member.gender IS DISTINCT FROM v_student.gender
        )
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

REVOKE ALL ON FUNCTION public.dorm_request_join_group(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dorm_respond_join_request(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dorm_student_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dorm_request_join_group(text, text) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.dorm_respond_join_request(text, boolean) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.dorm_student_state() TO authenticated;
