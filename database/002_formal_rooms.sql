ALTER TABLE public.dorm_students ADD COLUMN IF NOT EXISTS gender text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dorm_students_gender_check' AND conrelid = 'public.dorm_students'::regclass
  ) THEN
    ALTER TABLE public.dorm_students
      ADD CONSTRAINT dorm_students_gender_check CHECK (gender IN ('男', '女'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS dorm_students_class_gender_idx ON public.dorm_students(class_id, gender);

CREATE TABLE IF NOT EXISTS public.dorm_rooms (
  room_number text PRIMARY KEY,
  class_id text NOT NULL CHECK (class_id IN ('1', '2', '3', '4', 'shared')),
  gender text NOT NULL CHECK (gender IN ('男', '女')),
  capacity integer NOT NULL DEFAULT 4 CHECK (capacity = 4),
  active boolean NOT NULL DEFAULT true
);

INSERT INTO public.dorm_rooms(room_number, class_id, gender, capacity) VALUES
  ('11', '1', '女', 4), ('12', '1', '女', 4),
  ('21', '2', '女', 4), ('22', '2', '女', 4),
  ('31', '3', '女', 4), ('32', '3', '女', 4),
  ('41', '4', '女', 4), ('42', '4', '女', 4),
  ('51', 'shared', '女', 4),
  ('101', '1', '男', 4), ('102', '1', '男', 4), ('103', '1', '男', 4), ('104', '1', '男', 4), ('105', '1', '男', 4), ('106', '1', '男', 4), ('107', '1', '男', 4), ('108', '1', '男', 4), ('109', '1', '男', 4), ('110', '1', '男', 4), ('111', '1', '男', 4),
  ('201', '2', '男', 4), ('202', '2', '男', 4), ('203', '2', '男', 4), ('204', '2', '男', 4), ('205', '2', '男', 4), ('206', '2', '男', 4), ('207', '2', '男', 4), ('208', '2', '男', 4), ('209', '2', '男', 4), ('210', '2', '男', 4), ('211', '2', '男', 4),
  ('301', '3', '男', 4), ('302', '3', '男', 4), ('303', '3', '男', 4), ('304', '3', '男', 4), ('305', '3', '男', 4), ('306', '3', '男', 4), ('307', '3', '男', 4), ('308', '3', '男', 4), ('309', '3', '男', 4), ('310', '3', '男', 4), ('311', '3', '男', 4),
  ('401', '4', '男', 4), ('402', '4', '男', 4), ('403', '4', '男', 4), ('404', '4', '男', 4), ('405', '4', '男', 4), ('406', '4', '男', 4), ('407', '4', '男', 4), ('408', '4', '男', 4), ('409', '4', '男', 4), ('410', '4', '男', 4), ('411', '4', '男', 4)
ON CONFLICT (room_number) DO UPDATE SET
  class_id = EXCLUDED.class_id,
  gender = EXCLUDED.gender,
  capacity = EXCLUDED.capacity,
  active = true;

CREATE TABLE IF NOT EXISTS public.dorm_assignments (
  student_id text PRIMARY KEY REFERENCES public.dorm_students(id) ON DELETE CASCADE,
  class_id text NOT NULL CHECK (class_id IN ('1', '2', '3', '4')),
  gender text NOT NULL CHECK (gender IN ('男', '女')),
  room_number text NOT NULL REFERENCES public.dorm_rooms(room_number),
  bed_no integer CHECK (bed_no BETWEEN 1 AND 4),
  run_id text NOT NULL REFERENCES public.dorm_allocation_runs(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  bed_selected_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS dorm_assignments_room_bed_unique
  ON public.dorm_assignments(room_number, bed_no) WHERE bed_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS dorm_assignments_room_idx ON public.dorm_assignments(room_number);

ALTER TABLE public.dorm_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dorm_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dorm_rooms, public.dorm_assignments FROM anon, authenticated;
GRANT ALL ON public.dorm_rooms, public.dorm_assignments TO service_role;

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
  IF v_sender.gender IS NULL OR v_candidate.gender IS NULL OR v_candidate.gender <> v_sender.gender THEN RAISE EXCEPTION '只能邀请同班同性别学生'; END IF;
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
  IF NOT FOUND THEN RAISE EXCEPTION '当前账号尚未通过学生名单核验'; END IF;
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

CREATE OR REPLACE FUNCTION public.dorm_admin_snapshot(p_class_id text DEFAULT 'all')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.dorm_admins WHERE uid = v_uid) THEN RAISE EXCEPTION '没有辅导员权限'; END IF;
  RETURN jsonb_build_object(
    'students', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'class_id', s.class_id, 'class_name', s.class_name, 'class_code', s.class_code,
      'student_id', s.student_id, 'name', s.name, 'gender', s.gender,
      'survey_completed', s.survey_completed, 'group_id', s.group_id,
      'bed_need', s.bed_need, 'bed_need_approved', s.bed_need_approved
    ) ORDER BY s.class_id, s.student_id) FROM public.dorm_students s WHERE p_class_id = 'all' OR s.class_id = p_class_id), '[]'::jsonb),
    'surveys', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'student_id', q.student_id, 'class_id', q.class_id, 'answers', q.answers,
      'completed', q.completed, 'updated_at', q.updated_at
    )) FROM public.dorm_surveys q WHERE p_class_id = 'all' OR q.class_id = p_class_id), '[]'::jsonb),
    'groups', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', g.id, 'class_id', g.class_id, 'member_ids', g.member_ids,
      'confirmed_ids', g.confirmed_ids, 'status', g.status, 'compatibility_score', g.compatibility_score
    ) ORDER BY g.class_id, g.created_at) FROM public.dorm_groups g WHERE p_class_id = 'all' OR g.class_id = p_class_id), '[]'::jsonb),
    'rooms', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'room_number', r.room_number, 'class_id', r.class_id, 'gender', r.gender,
      'capacity', r.capacity, 'active', r.active
    ) ORDER BY r.class_id, r.gender, r.room_number) FROM public.dorm_rooms r WHERE p_class_id = 'all' OR r.class_id = p_class_id), '[]'::jsonb),
    'assignments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'student_id', a.student_id, 'class_id', a.class_id, 'gender', a.gender,
      'room_number', a.room_number, 'bed_no', a.bed_no, 'run_id', a.run_id
    )) FROM public.dorm_assignments a WHERE p_class_id = 'all' OR a.class_id = p_class_id), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.dorm_publish_allocation(p_run_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_run public.dorm_allocation_runs%ROWTYPE;
  v_room jsonb;
  v_member jsonb;
  v_room_row public.dorm_rooms%ROWTYPE;
  v_student public.dorm_students%ROWTYPE;
  v_count integer := 0;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.dorm_admins WHERE uid = v_uid) THEN RAISE EXCEPTION '没有辅导员权限'; END IF;
  SELECT * INTO v_run FROM public.dorm_allocation_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '分配方案不存在'; END IF;
  IF v_run.status <> 'draft' THEN RAISE EXCEPTION '该方案不是待发布状态'; END IF;

  IF v_run.class_id = 'all' THEN DELETE FROM public.dorm_assignments;
  ELSE DELETE FROM public.dorm_assignments WHERE class_id = v_run.class_id;
  END IF;

  FOR v_room IN SELECT value FROM jsonb_array_elements(v_run.rooms)
  LOOP
    SELECT * INTO v_room_row FROM public.dorm_rooms WHERE room_number = v_room->>'roomNumber' AND active = true;
    IF NOT FOUND THEN RAISE EXCEPTION '寝室号 % 不存在', v_room->>'roomNumber'; END IF;
    IF v_room_row.class_id <> v_room->>'classId' OR v_room_row.gender <> v_room->>'gender' THEN RAISE EXCEPTION '寝室 % 与班级或性别不一致', v_room_row.room_number; END IF;
    IF jsonb_array_length(v_room->'members') > v_room_row.capacity THEN RAISE EXCEPTION '寝室 % 超出容量', v_room_row.room_number; END IF;

    FOR v_member IN SELECT value FROM jsonb_array_elements(v_room->'members')
    LOOP
      SELECT * INTO v_student FROM public.dorm_students WHERE id = v_member->>'id';
      IF NOT FOUND OR (v_room_row.class_id <> 'shared' AND v_student.class_id <> v_room_row.class_id) OR v_student.gender <> v_room_row.gender THEN RAISE EXCEPTION '学生与寝室班级或性别不一致'; END IF;
      INSERT INTO public.dorm_assignments(student_id, class_id, gender, room_number, run_id)
      VALUES (v_student.id, v_student.class_id, v_student.gender, v_room_row.room_number, v_run.id);
      v_count := v_count + 1;
    END LOOP;
  END LOOP;

  UPDATE public.dorm_allocation_runs SET status = 'superseded'
  WHERE id <> v_run.id AND status = 'published' AND (v_run.class_id = 'all' OR class_id = v_run.class_id OR class_id = 'all');
  UPDATE public.dorm_allocation_runs SET status = 'published' WHERE id = v_run.id;
  INSERT INTO public.dorm_audit_logs(action, uid, entity_id, detail)
  VALUES ('ALLOCATION_PUBLISH', v_uid, v_run.id, jsonb_build_object('studentCount', v_count));
  RETURN jsonb_build_object('runId', v_run.id, 'status', 'published', 'studentCount', v_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.dorm_choose_bed(p_bed_no integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_student public.dorm_students%ROWTYPE;
  v_assignment public.dorm_assignments%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF p_bed_no NOT BETWEEN 1 AND 4 THEN RAISE EXCEPTION '床位号只能选择1至4'; END IF;
  SELECT * INTO v_student FROM public.dorm_students WHERE auth_uid = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION '当前账号尚未通过学生名单核验'; END IF;
  SELECT * INTO v_assignment FROM public.dorm_assignments WHERE student_id = v_student.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '辅导员尚未发布你的寝室结果'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dorm_allocation_runs WHERE id = v_assignment.run_id AND status = 'published') THEN RAISE EXCEPTION '当前分配结果尚未发布'; END IF;

  BEGIN
    UPDATE public.dorm_assignments SET bed_no = p_bed_no, bed_selected_at = now() WHERE student_id = v_student.id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION '该床位刚刚被室友选走，请选择其他床位';
  END;
  INSERT INTO public.dorm_audit_logs(action, uid, entity_id, detail)
  VALUES ('BED_SELECT', v_uid, v_student.id, jsonb_build_object('roomNumber', v_assignment.room_number, 'bedNo', p_bed_no));
  RETURN jsonb_build_object('roomNumber', v_assignment.room_number, 'bedNo', p_bed_no);
END;
$$;

REVOKE ALL ON FUNCTION public.dorm_publish_allocation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dorm_choose_bed(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dorm_publish_allocation(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dorm_choose_bed(integer) TO authenticated;
