CREATE TABLE IF NOT EXISTS public.dorm_students (
  id text PRIMARY KEY,
  class_id text NOT NULL CHECK (class_id IN ('1', '2', '3', '4')),
  class_name text NOT NULL,
  class_code text NOT NULL,
  student_id text NOT NULL UNIQUE,
  name text NOT NULL,
  auth_uid text UNIQUE,
  survey_completed boolean NOT NULL DEFAULT false,
  group_id text,
  bed_need text NOT NULL DEFAULT '无',
  bed_need_approved boolean NOT NULL DEFAULT false,
  bound_at timestamptz,
  survey_updated_at timestamptz
);

CREATE INDEX IF NOT EXISTS dorm_students_class_idx ON public.dorm_students(class_id);
CREATE INDEX IF NOT EXISTS dorm_students_group_idx ON public.dorm_students(group_id);

CREATE TABLE IF NOT EXISTS public.dorm_surveys (
  student_id text PRIMARY KEY REFERENCES public.dorm_students(id) ON DELETE CASCADE,
  class_id text NOT NULL,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed boolean NOT NULL DEFAULT true,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.dorm_groups (
  id text PRIMARY KEY,
  class_id text NOT NULL CHECK (class_id IN ('1', '2', '3', '4')),
  member_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  confirmed_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'forming' CHECK (status IN ('forming', 'complete', 'rejected')),
  compatibility_score numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dorm_groups_class_idx ON public.dorm_groups(class_id);

CREATE TABLE IF NOT EXISTS public.dorm_invitations (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES public.dorm_groups(id) ON DELETE CASCADE,
  from_student_id text NOT NULL REFERENCES public.dorm_students(id) ON DELETE CASCADE,
  to_student_id text NOT NULL REFERENCES public.dorm_students(id) ON DELETE CASCADE,
  class_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz
);

CREATE INDEX IF NOT EXISTS dorm_invites_to_idx ON public.dorm_invitations(to_student_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS dorm_invites_pending_unique ON public.dorm_invitations(group_id, to_student_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.dorm_audit_logs (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  uid text NOT NULL,
  entity_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.dorm_allocation_runs (
  id text PRIMARY KEY,
  version text NOT NULL,
  class_id text NOT NULL,
  rooms jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'draft'
);

ALTER TABLE public.dorm_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dorm_surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dorm_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dorm_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dorm_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dorm_allocation_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.dorm_students, public.dorm_surveys, public.dorm_groups, public.dorm_invitations, public.dorm_audit_logs, public.dorm_allocation_runs FROM anon, authenticated;
GRANT ALL ON public.dorm_students, public.dorm_surveys, public.dorm_groups, public.dorm_invitations, public.dorm_audit_logs, public.dorm_allocation_runs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.dorm_audit_logs_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.dorm_bind_student(
  p_class_name text,
  p_class_code text,
  p_name text,
  p_student_id text,
  p_uid text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_student public.dorm_students%ROWTYPE;
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT * INTO v_student
  FROM public.dorm_students
  WHERE class_name = p_class_name AND class_code = p_class_code AND name = p_name AND student_id = p_student_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION '名单核验失败，请检查班级、姓名和学号'; END IF;
  IF v_student.auth_uid IS NOT NULL AND v_student.auth_uid <> v_uid THEN
    RAISE EXCEPTION '该学生身份已绑定其他设备，请联系辅导员处理';
  END IF;

  IF v_student.auth_uid IS NULL THEN
    UPDATE public.dorm_students SET auth_uid = v_uid, bound_at = now() WHERE id = v_student.id;
    INSERT INTO public.dorm_audit_logs(action, uid, entity_id) VALUES ('STUDENT_BIND', v_uid, v_student.id);
  END IF;

  RETURN jsonb_build_object('studentId', v_student.id, 'name', v_student.name, 'className', v_student.class_name);
END;
$$;

CREATE OR REPLACE FUNCTION public.dorm_submit_survey(p_uid text, p_answers jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_student public.dorm_students%ROWTYPE;
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT * INTO v_student FROM public.dorm_students WHERE auth_uid = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '当前账号尚未通过学生名单核验'; END IF;
  IF p_answers->>'studentId' <> v_student.student_id OR p_answers->>'name' <> v_student.name OR p_answers->>'className' <> v_student.class_name THEN
    RAISE EXCEPTION '问卷身份信息与导入名单不一致';
  END IF;

  INSERT INTO public.dorm_surveys(student_id, class_id, answers, completed, submitted_at, updated_at)
  VALUES (v_student.id, v_student.class_id, p_answers, true, now(), now())
  ON CONFLICT (student_id) DO UPDATE SET answers = EXCLUDED.answers, completed = true, updated_at = now();

  UPDATE public.dorm_students
  SET survey_completed = true, survey_updated_at = now(), bed_need = COALESCE(NULLIF(p_answers->>'bedNeed', ''), '无')
  WHERE id = v_student.id;

  INSERT INTO public.dorm_audit_logs(action, uid, entity_id, detail)
  VALUES ('SURVEY_SUBMIT', v_uid, v_student.id, jsonb_build_object('answerKeys', (SELECT jsonb_agg(answer_key) FROM jsonb_object_keys(p_answers) AS answer_key)));
  RETURN jsonb_build_object('receipt', 'SURVEY-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)));
END;
$$;

CREATE OR REPLACE FUNCTION public.dorm_create_invite(
  p_uid text,
  p_candidate_id text,
  p_new_group_id text,
  p_invite_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender public.dorm_students%ROWTYPE;
  v_candidate public.dorm_students%ROWTYPE;
  v_group public.dorm_groups%ROWTYPE;
  v_group_id text;
  v_existing_id text;
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT * INTO v_sender FROM public.dorm_students WHERE auth_uid = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '当前账号尚未通过学生名单核验'; END IF;
  IF NOT v_sender.survey_completed THEN RAISE EXCEPTION '请先完成个人问卷'; END IF;

  SELECT * INTO v_candidate FROM public.dorm_students WHERE id = p_candidate_id FOR UPDATE;
  IF NOT FOUND OR v_candidate.class_id <> v_sender.class_id THEN RAISE EXCEPTION '只能邀请同班学生'; END IF;
  IF NOT v_candidate.survey_completed THEN RAISE EXCEPTION '对方尚未完成问卷'; END IF;
  IF v_candidate.group_id IS NOT NULL THEN RAISE EXCEPTION '对方已经加入其他小组'; END IF;

  v_group_id := v_sender.group_id;
  IF v_group_id IS NULL THEN
    v_group_id := p_new_group_id;
    INSERT INTO public.dorm_groups(id, class_id, member_ids, confirmed_ids) VALUES (v_group_id, v_sender.class_id, ARRAY[v_sender.id], ARRAY[v_sender.id]);
    UPDATE public.dorm_students SET group_id = v_group_id WHERE id = v_sender.id;
  END IF;

  SELECT * INTO v_group FROM public.dorm_groups WHERE id = v_group_id FOR UPDATE;
  IF NOT FOUND OR cardinality(v_group.member_ids) >= 4 THEN RAISE EXCEPTION '当前小组已经满员'; END IF;

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
SET search_path = public
AS $$
DECLARE
  v_student public.dorm_students%ROWTYPE;
  v_invite public.dorm_invitations%ROWTYPE;
  v_group public.dorm_groups%ROWTYPE;
  v_member_ids text[];
  v_confirmed_ids text[];
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT * INTO v_student FROM public.dorm_students WHERE auth_uid = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '当前账号尚未通过学生名单核验'; END IF;
  SELECT * INTO v_invite FROM public.dorm_invitations WHERE id = p_invite_id FOR UPDATE;
  IF NOT FOUND OR v_invite.to_student_id <> v_student.id OR v_invite.status <> 'pending' THEN RAISE EXCEPTION '邀请不存在或已经处理'; END IF;

  IF NOT p_accepted THEN
    UPDATE public.dorm_invitations SET status = 'declined', responded_at = now() WHERE id = v_invite.id;
    INSERT INTO public.dorm_audit_logs(action, uid, entity_id) VALUES ('GROUP_INVITE_DECLINE', v_uid, v_invite.id);
    RETURN jsonb_build_object('status', 'declined');
  END IF;

  IF v_student.group_id IS NOT NULL THEN RAISE EXCEPTION '你已经加入其他小组'; END IF;
  SELECT * INTO v_group FROM public.dorm_groups WHERE id = v_invite.group_id FOR UPDATE;
  IF NOT FOUND OR cardinality(v_group.member_ids) >= 4 OR v_group.class_id <> v_student.class_id THEN RAISE EXCEPTION '该小组已满或不再有效'; END IF;

  v_member_ids := array_append(v_group.member_ids, v_student.id);
  v_confirmed_ids := array_append(v_group.confirmed_ids, v_student.id);
  UPDATE public.dorm_groups SET member_ids = v_member_ids, confirmed_ids = v_confirmed_ids, status = CASE WHEN cardinality(v_member_ids) = 4 THEN 'complete' ELSE 'forming' END, updated_at = now() WHERE id = v_group.id;
  UPDATE public.dorm_students SET group_id = v_group.id WHERE id = v_student.id;
  UPDATE public.dorm_invitations SET status = 'accepted', responded_at = now() WHERE id = v_invite.id;
  UPDATE public.dorm_invitations SET status = 'cancelled', responded_at = now() WHERE to_student_id = v_student.id AND status = 'pending' AND id <> v_invite.id;
  INSERT INTO public.dorm_audit_logs(action, uid, entity_id, detail) VALUES ('GROUP_INVITE_ACCEPT', v_uid, v_invite.id, jsonb_build_object('groupId', v_group.id));
  RETURN jsonb_build_object('status', 'accepted', 'groupId', v_group.id, 'memberCount', cardinality(v_member_ids));
END;
$$;

REVOKE ALL ON FUNCTION public.dorm_bind_student(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dorm_submit_survey(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dorm_create_invite(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dorm_respond_invite(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dorm_bind_student(text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.dorm_submit_survey(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.dorm_create_invite(text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.dorm_respond_invite(text, text, boolean) TO service_role;

CREATE TABLE IF NOT EXISTS public.dorm_admins (
  uid text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.dorm_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dorm_admins FROM anon, authenticated;
GRANT ALL ON public.dorm_admins TO service_role;
-- {{ADMIN_UID}} 会在 scripts/apply-database.mjs 执行时自动替换为 .env.local 中的 ADMIN_UID。
INSERT INTO public.dorm_admins(uid) VALUES ('{{ADMIN_UID}}') ON CONFLICT (uid) DO NOTHING;

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
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT * INTO v_student FROM public.dorm_students WHERE auth_uid = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION '当前账号尚未通过学生名单核验'; END IF;
  IF v_student.group_id IS NOT NULL THEN
    SELECT * INTO v_group FROM public.dorm_groups WHERE id = v_student.group_id;
  END IF;

  RETURN jsonb_build_object(
    'student', jsonb_build_object('id', v_student.id, 'name', v_student.name, 'classId', v_student.class_id),
    'surveyCompleted', v_student.survey_completed,
    'group', CASE WHEN v_group.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_group.id,
      'classId', v_group.class_id,
      'memberIds', v_group.member_ids,
      'confirmedIds', v_group.confirmed_ids,
      'status', v_group.status,
      'compatibilityScore', COALESCE(v_group.compatibility_score, 0)
    ) END,
    'groupMembers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'confirmed', s.id = ANY(COALESCE(v_group.confirmed_ids, ARRAY[]::text[]))
      ) ORDER BY s.name)
      FROM public.dorm_students s
      WHERE s.id = ANY(COALESCE(v_group.member_ids, ARRAY[]::text[]))
    ), '[]'::jsonb),
    'incomingInvites', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', i.id,
        'groupId', i.group_id,
        'fromStudentId', i.from_student_id,
        'fromStudentName', COALESCE(sender.name, '同班同学')
      ) ORDER BY i.created_at DESC)
      FROM public.dorm_invitations i
      LEFT JOIN public.dorm_students sender ON sender.id = i.from_student_id
      WHERE i.to_student_id = v_student.id AND i.status = 'pending'
    ), '[]'::jsonb),
    'candidates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
      FROM public.dorm_students s
      WHERE s.class_id = v_student.class_id
        AND s.survey_completed = true
        AND s.group_id IS NULL
        AND s.id <> v_student.id
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.dorm_admin_snapshot(p_class_id text DEFAULT 'all')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.dorm_admins WHERE uid = v_uid) THEN
    RAISE EXCEPTION '没有辅导员权限';
  END IF;

  RETURN jsonb_build_object(
    'students', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', s.id,
        'class_id', s.class_id,
        'class_name', s.class_name,
        'class_code', s.class_code,
        'student_id', s.student_id,
        'name', s.name,
        'survey_completed', s.survey_completed,
        'group_id', s.group_id,
        'bed_need', s.bed_need,
        'bed_need_approved', s.bed_need_approved
      ) ORDER BY s.class_id, s.student_id)
      FROM public.dorm_students s
      WHERE p_class_id = 'all' OR s.class_id = p_class_id
    ), '[]'::jsonb),
    'surveys', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'student_id', q.student_id,
        'class_id', q.class_id,
        'answers', q.answers,
        'completed', q.completed,
        'updated_at', q.updated_at
      ))
      FROM public.dorm_surveys q
      WHERE p_class_id = 'all' OR q.class_id = p_class_id
    ), '[]'::jsonb),
    'groups', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', g.id,
        'class_id', g.class_id,
        'member_ids', g.member_ids,
        'confirmed_ids', g.confirmed_ids,
        'status', g.status,
        'compatibility_score', g.compatibility_score
      ) ORDER BY g.class_id, g.created_at)
      FROM public.dorm_groups g
      WHERE p_class_id = 'all' OR g.class_id = p_class_id
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.dorm_save_allocation(
  p_run_id text,
  p_version text,
  p_class_id text,
  p_rooms jsonb,
  p_pending jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.dorm_admins WHERE uid = v_uid) THEN
    RAISE EXCEPTION '没有辅导员权限';
  END IF;
  INSERT INTO public.dorm_allocation_runs(id, version, class_id, rooms, pending, created_by, status)
  VALUES (p_run_id, p_version, p_class_id, p_rooms, p_pending, v_uid, 'draft');
  INSERT INTO public.dorm_audit_logs(action, uid, entity_id, detail)
  VALUES ('ALLOCATION_GENERATE', v_uid, p_run_id, jsonb_build_object(
    'roomCount', jsonb_array_length(p_rooms),
    'pendingCount', jsonb_array_length(p_pending),
    'version', p_version
  ));
  RETURN jsonb_build_object('runId', p_run_id, 'version', p_version);
END;
$$;

REVOKE ALL ON FUNCTION public.dorm_student_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dorm_admin_snapshot(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dorm_save_allocation(text, text, text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dorm_bind_student(text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dorm_submit_survey(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dorm_create_invite(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dorm_respond_invite(text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dorm_student_state() TO authenticated;
GRANT EXECUTE ON FUNCTION public.dorm_admin_snapshot(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dorm_save_allocation(text, text, text, jsonb, jsonb) TO authenticated;
