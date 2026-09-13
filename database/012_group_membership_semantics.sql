-- 只更新组队函数，保留原有权限，不批量修改任何业务数据。
CREATE OR REPLACE FUNCTION public.dorm_create_invite(p_uid text, p_candidate_id text, p_new_group_id text, p_invite_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
DECLARE
  v_sender public.dorm_students%ROWTYPE;
  v_candidate public.dorm_students%ROWTYPE;
  v_group public.dorm_groups%ROWTYPE;
  v_group_id text;
  v_existing_id text;
  v_candidate_group public.dorm_groups%ROWTYPE;
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('dorm-group-membership-v2'));
  SELECT * INTO v_sender FROM public.dorm_students WHERE auth_uid = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '当前账号尚未通过学生名单核验'; END IF;
  IF NOT v_sender.survey_completed THEN RAISE EXCEPTION '请先完成个人问卷'; END IF;

  SELECT * INTO v_candidate FROM public.dorm_students WHERE id = p_candidate_id FOR UPDATE;
  IF NOT FOUND OR v_candidate.class_id <> v_sender.class_id THEN RAISE EXCEPTION '只能邀请同班学生'; END IF;
  IF v_sender.gender IS NULL OR v_candidate.gender IS NULL OR v_candidate.gender <> v_sender.gender THEN RAISE EXCEPTION '只能邀请同班同性别学生'; END IF;
  IF NOT v_candidate.survey_completed THEN RAISE EXCEPTION '对方尚未完成问卷'; END IF;
  IF v_candidate.id = v_sender.id THEN RAISE EXCEPTION '不能邀请自己'; END IF;
  IF v_candidate.group_id IS NOT NULL THEN
    SELECT * INTO v_candidate_group FROM public.dorm_groups WHERE id = v_candidate.group_id FOR UPDATE;
    IF NOT FOUND OR v_candidate_group.status <> 'forming' OR v_candidate_group.member_ids <> ARRAY[v_candidate.id] THEN
      RAISE EXCEPTION '对方已经加入多人小组，或小组状态需要复核';
    END IF;
  END IF;

  v_group_id := v_sender.group_id;
  IF v_group_id IS NULL THEN
    v_group_id := p_new_group_id;
    INSERT INTO public.dorm_groups(id, class_id, member_ids, confirmed_ids) VALUES (v_group_id, v_sender.class_id, ARRAY[v_sender.id], ARRAY[v_sender.id]);
    UPDATE public.dorm_students SET group_id = v_group_id WHERE id = v_sender.id;
  END IF;

  SELECT * INTO v_group FROM public.dorm_groups WHERE id = v_group_id FOR UPDATE;
  IF NOT FOUND OR v_group.status <> 'forming' OR cardinality(v_group.member_ids) NOT BETWEEN 1 AND 3
    OR NOT (v_sender.id = ANY(v_group.member_ids)) OR NOT (v_group.member_ids <@ v_group.confirmed_ids) THEN
    RAISE EXCEPTION '当前小组已满员或成员状态需要复核';
  END IF;

  SELECT id INTO v_existing_id FROM public.dorm_invitations WHERE group_id = v_group_id AND to_student_id = v_candidate.id AND status = 'pending' LIMIT 1;
  IF v_existing_id IS NOT NULL THEN RETURN jsonb_build_object('status', 'pending', 'inviteId', v_existing_id); END IF;

  INSERT INTO public.dorm_invitations(id, group_id, from_student_id, to_student_id, class_id)
  VALUES (p_invite_id, v_group_id, v_sender.id, v_candidate.id, v_sender.class_id);
  INSERT INTO public.dorm_audit_logs(action, uid, entity_id, detail)
  VALUES ('GROUP_INVITE', v_uid, p_invite_id, jsonb_build_object('groupId', v_group_id, 'toStudentId', v_candidate.id));
  RETURN jsonb_build_object('status', 'pending', 'inviteId', p_invite_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.dorm_respond_invite(p_uid text, p_invite_id text, p_accepted boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
DECLARE
  v_student public.dorm_students%ROWTYPE;
  v_invite public.dorm_invitations%ROWTYPE;
  v_group public.dorm_groups%ROWTYPE;
  v_old_group public.dorm_groups%ROWTYPE;
  v_member_ids text[];
  v_confirmed_ids text[];
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('dorm-group-membership-v2'));
  IF p_accepted IS NULL THEN RAISE EXCEPTION '请选择接受或拒绝'; END IF;
  SELECT * INTO v_student FROM public.dorm_students WHERE auth_uid = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '当前账号尚未通过学生名单核验'; END IF;
  SELECT * INTO v_invite FROM public.dorm_invitations WHERE id = p_invite_id FOR UPDATE;
  IF NOT FOUND OR v_invite.to_student_id <> v_student.id OR v_invite.status <> 'pending' THEN RAISE EXCEPTION '邀请不存在或已经处理'; END IF;

  IF NOT p_accepted THEN
    UPDATE public.dorm_invitations SET status = 'declined', responded_at = now() WHERE id = v_invite.id;
    INSERT INTO public.dorm_audit_logs(action, uid, entity_id) VALUES ('GROUP_INVITE_DECLINE', v_uid, v_invite.id);
    RETURN jsonb_build_object('status', 'declined');
  END IF;

  IF NOT v_student.survey_completed THEN RAISE EXCEPTION '请先完成个人问卷'; END IF;
  SELECT * INTO v_group FROM public.dorm_groups WHERE id = v_invite.group_id FOR UPDATE;
  IF NOT FOUND OR v_group.status <> 'forming' OR cardinality(v_group.member_ids) NOT BETWEEN 1 AND 3
    OR v_group.class_id <> v_student.class_id OR v_student.id = ANY(v_group.member_ids)
    OR NOT (v_invite.from_student_id = ANY(v_group.member_ids))
    OR NOT (v_group.member_ids <@ v_group.confirmed_ids) THEN RAISE EXCEPTION '该小组已满或不再有效'; END IF;
  IF v_student.gender IS NULL OR EXISTS (
    SELECT 1 FROM public.dorm_students member WHERE member.id = ANY(v_group.member_ids)
      AND (member.gender IS DISTINCT FROM v_student.gender OR NOT member.survey_completed OR member.group_id IS DISTINCT FROM v_group.id)
  ) THEN RAISE EXCEPTION '只能加入同班同性别且已完成问卷的小组'; END IF;
  IF v_student.group_id IS NOT NULL THEN
    SELECT * INTO v_old_group FROM public.dorm_groups WHERE id = v_student.group_id FOR UPDATE;
    IF NOT FOUND OR v_old_group.status <> 'forming' OR v_old_group.member_ids <> ARRAY[v_student.id] THEN
      RAISE EXCEPTION '你已经加入其他多人小组，不能直接换组';
    END IF;
    -- 只退役属于本人的单人临时组，保留历史，不操作任何多人组。
    UPDATE public.dorm_invitations SET status = 'cancelled', responded_at = now()
      WHERE group_id = v_old_group.id AND status = 'pending';
    UPDATE public.dorm_join_requests SET status = 'cancelled', responded_at = now()
      WHERE group_id = v_old_group.id AND status = 'pending';
    UPDATE public.dorm_groups SET member_ids = ARRAY[]::text[], confirmed_ids = ARRAY[]::text[],
      status = 'rejected', updated_at = now() WHERE id = v_old_group.id;
  END IF;

  v_member_ids := array_append(v_group.member_ids, v_student.id);
  v_confirmed_ids := array_append(v_group.confirmed_ids, v_student.id);
  UPDATE public.dorm_groups SET member_ids = v_member_ids, confirmed_ids = v_confirmed_ids, status = CASE WHEN cardinality(v_member_ids) = 4 THEN 'complete' ELSE 'forming' END, updated_at = now() WHERE id = v_group.id;
  UPDATE public.dorm_students SET group_id = v_group.id WHERE id = v_student.id;
  UPDATE public.dorm_invitations SET status = 'accepted', responded_at = now() WHERE id = v_invite.id;
  UPDATE public.dorm_invitations SET status = 'cancelled', responded_at = now() WHERE to_student_id = v_student.id AND status = 'pending' AND id <> v_invite.id;
  UPDATE public.dorm_join_requests SET status = 'cancelled', responded_at = now()
    WHERE applicant_student_id = v_student.id AND status = 'pending';
  IF cardinality(v_member_ids) = 4 THEN
    UPDATE public.dorm_invitations SET status = 'cancelled', responded_at = now() WHERE group_id = v_group.id AND status = 'pending';
    UPDATE public.dorm_join_requests SET status = 'cancelled', responded_at = now() WHERE group_id = v_group.id AND status = 'pending';
  END IF;
  INSERT INTO public.dorm_audit_logs(action, uid, entity_id, detail) VALUES ('GROUP_INVITE_ACCEPT', v_uid, v_invite.id, jsonb_build_object('groupId', v_group.id));
  RETURN jsonb_build_object('status', 'accepted', 'groupId', v_group.id, 'memberCount', cardinality(v_member_ids));
END;
$$;

CREATE OR REPLACE FUNCTION public.dorm_request_join_group(p_group_id text, p_request_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
DECLARE
  v_uid text := auth.uid();
  v_applicant public.dorm_students%ROWTYPE;
  v_current_group public.dorm_groups%ROWTYPE;
  v_target_group public.dorm_groups%ROWTYPE;
  v_existing_id text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('dorm-group-membership-v2'));
  SELECT * INTO v_applicant FROM public.dorm_students WHERE auth_uid = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '当前浏览器未关联学生身份，请重新核验名单'; END IF;
  IF NOT v_applicant.survey_completed THEN RAISE EXCEPTION '请先完成个人问卷'; END IF;

  IF v_applicant.group_id IS NOT NULL THEN
    SELECT * INTO v_current_group FROM public.dorm_groups WHERE id = v_applicant.group_id FOR UPDATE;
    IF NOT FOUND OR v_current_group.status <> 'forming' OR v_current_group.member_ids <> ARRAY[v_applicant.id] THEN
      RAISE EXCEPTION '你已经加入多人小组或成员状态需要复核，不能申请其他小组';
    END IF;
  END IF;

  SELECT * INTO v_target_group FROM public.dorm_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND OR v_target_group.status <> 'forming' OR cardinality(v_target_group.member_ids) NOT BETWEEN 2 AND 3 OR NOT (v_target_group.member_ids <@ v_target_group.confirmed_ids) THEN
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
 SET search_path TO 'public'
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
  PERFORM pg_advisory_xact_lock(hashtext('dorm-group-membership-v2'));
  IF p_accepted IS NULL THEN RAISE EXCEPTION '请选择同意或拒绝'; END IF;
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

  IF v_target_group.status <> 'forming' OR cardinality(v_target_group.member_ids) NOT BETWEEN 2 AND 3 OR NOT (v_target_group.member_ids <@ v_target_group.confirmed_ids) THEN RAISE EXCEPTION '该小组已满员或不再有效'; END IF;
  SELECT * INTO v_applicant FROM public.dorm_students WHERE id = v_request.applicant_student_id FOR UPDATE;
  IF NOT FOUND OR NOT v_applicant.survey_completed OR v_applicant.class_id <> v_target_group.class_id THEN RAISE EXCEPTION '申请人当前不符合加入条件'; END IF;
  IF v_applicant.gender IS NULL OR EXISTS (
    SELECT 1 FROM public.dorm_students member
    WHERE member.id = ANY(v_target_group.member_ids) AND member.gender IS DISTINCT FROM v_applicant.gender
  ) THEN RAISE EXCEPTION '申请人与小组性别不一致'; END IF;

  IF v_applicant.id = ANY(v_target_group.member_ids) THEN RAISE EXCEPTION '该同学已是组内成员'; END IF;
  IF v_applicant.group_id IS NOT NULL THEN
    SELECT * INTO v_old_group FROM public.dorm_groups WHERE id = v_applicant.group_id FOR UPDATE;
    IF NOT FOUND OR v_old_group.status <> 'forming' OR v_old_group.member_ids <> ARRAY[v_applicant.id] THEN
      RAISE EXCEPTION '申请人已经加入其他多人小组';
    END IF;
    -- 只退役属于本人的单人临时组，保留历史，不操作任何多人组。
    UPDATE public.dorm_invitations SET status = 'cancelled', responded_at = now()
      WHERE group_id = v_old_group.id AND status = 'pending';
    UPDATE public.dorm_join_requests SET status = 'cancelled', responded_at = now()
      WHERE group_id = v_old_group.id AND status = 'pending';
    UPDATE public.dorm_groups SET member_ids = ARRAY[]::text[], confirmed_ids = ARRAY[]::text[],
      status = 'rejected', updated_at = now() WHERE id = v_old_group.id;
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
 SET search_path TO 'public'
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
      'outgoingInvites', '[]'::jsonb,
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
    'outgoingInvites', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', i.id, 'toStudentId', i.to_student_id) ORDER BY i.created_at DESC)
      FROM public.dorm_invitations i WHERE i.group_id = v_group.id AND i.status = 'pending'
        AND v_student.id = ANY(v_group.member_ids)
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
        AND candidate_group.member_ids <@ candidate_group.confirmed_ids
        AND NOT EXISTS (
          SELECT 1 FROM public.dorm_students member
          WHERE member.id = ANY(candidate_group.member_ids) AND member.gender IS DISTINCT FROM v_student.gender
        )
    ), '[]'::jsonb),
    'candidates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
      FROM public.dorm_students s
      WHERE s.class_id = v_student.class_id AND s.gender = v_student.gender
        AND s.survey_completed = true AND s.id <> v_student.id
        AND (s.group_id IS NULL OR EXISTS (
          SELECT 1 FROM public.dorm_groups singleton
          WHERE singleton.id = s.group_id AND singleton.status = 'forming' AND singleton.member_ids = ARRAY[s.id]
        ))
        AND (v_group.id IS NULL OR (v_group.status = 'forming' AND cardinality(v_group.member_ids) < 4))
        AND NOT (s.id = ANY(COALESCE(v_group.member_ids, ARRAY[]::text[])))
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
