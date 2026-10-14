-- 每所学校部署在独立 CloudBase 环境；本迁移只放宽班级编号，不迁移或清空试点数据。
ALTER TABLE public.dorm_students DROP CONSTRAINT IF EXISTS dorm_students_class_id_check;
ALTER TABLE public.dorm_groups DROP CONSTRAINT IF EXISTS dorm_groups_class_id_check;
ALTER TABLE public.dorm_rooms DROP CONSTRAINT IF EXISTS dorm_rooms_class_id_check;
ALTER TABLE public.dorm_assignments DROP CONSTRAINT IF EXISTS dorm_assignments_class_id_check;
ALTER TABLE public.dorm_join_requests DROP CONSTRAINT IF EXISTS dorm_join_requests_class_id_check;

CREATE TABLE IF NOT EXISTS public.dorm_classes (
  class_id text PRIMARY KEY,
  class_name text NOT NULL
);
ALTER TABLE public.dorm_classes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dorm_classes FROM anon, authenticated;
GRANT SELECT ON public.dorm_classes TO anon, authenticated;
GRANT ALL ON public.dorm_classes TO service_role;
DROP POLICY IF EXISTS dorm_classes_public_read ON public.dorm_classes;
CREATE POLICY dorm_classes_public_read ON public.dorm_classes FOR SELECT TO anon, authenticated USING (true);

-- 旧单校环境运行本迁移时只补公开班级名，绝不公开填写码或名单。
INSERT INTO public.dorm_classes(class_id, class_name)
SELECT class_id, MIN(class_name) FROM public.dorm_students GROUP BY class_id
ON CONFLICT (class_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.dorm_public_classes()
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('classId', class_id, 'className', class_name) ORDER BY class_name), '[]'::jsonb)
  FROM public.dorm_classes;
$$;
REVOKE ALL ON FUNCTION public.dorm_public_classes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dorm_public_classes() TO anon, authenticated;

-- 首次初始化在单次事务内写入；任何校验失败会整体回滚。
-- CloudBase 网关可能不强制 GRANT EXECUTE，因此必须在函数体内核对真实登录 UID。
CREATE OR REPLACE FUNCTION public.dorm_admin_initialize(p_students jsonb, p_rooms jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_student jsonb;
  v_room jsonb;
  v_class_id text;
  v_class_name text;
  v_class_code text;
  v_student_id text;
  v_name text;
  v_gender text;
  v_number text;
  v_shortage record;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.dorm_admins WHERE uid = v_uid) THEN
    RAISE EXCEPTION '没有辅导员权限';
  END IF;
  -- 同一环境并发的两次首次导入必须串行，防止同时通过空环境检查。
  PERFORM pg_advisory_xact_lock(1380465477, 1);
  IF p_students IS NULL OR jsonb_typeof(p_students) <> 'array' OR jsonb_array_length(p_students) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION '名单须包含1—2000名学生';
  END IF;
  IF p_rooms IS NULL OR jsonb_typeof(p_rooms) <> 'array' OR jsonb_array_length(p_rooms) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION '寝室须包含1—1000间';
  END IF;
  -- 即使有人直接调用 RPC，也不允许覆盖已使用的单校环境。
  IF EXISTS (SELECT 1 FROM public.dorm_students)
     OR EXISTS (SELECT 1 FROM public.dorm_surveys)
     OR EXISTS (SELECT 1 FROM public.dorm_groups)
     OR EXISTS (SELECT 1 FROM public.dorm_assignments)
     OR EXISTS (SELECT 1 FROM public.dorm_allocation_runs) THEN
    RAISE EXCEPTION '已有学生或分寝数据，禁止重新初始化';
  END IF;

  -- 新环境可能由旧迁移预置试点寝室；只有空环境允许清理这些默认寝室。
  DELETE FROM public.dorm_rooms;
  DELETE FROM public.dorm_classes;

  FOR v_student IN SELECT value FROM jsonb_array_elements(p_students)
  LOOP
    v_class_id := trim(v_student->>'classId');
    v_class_name := trim(v_student->>'className');
    v_class_code := trim(v_student->>'classCode');
    v_student_id := trim(v_student->>'studentId');
    v_name := trim(v_student->>'name');
    v_gender := trim(v_student->>'gender');
    IF v_class_id IS NULL OR v_class_id !~ '^[A-Za-z0-9_-]{1,32}$' OR v_class_id = 'shared'
       OR v_class_name IS NULL OR length(v_class_name) NOT BETWEEN 1 AND 80
       OR v_class_code IS NULL OR length(v_class_code) NOT BETWEEN 1 AND 32
       OR v_student_id IS NULL OR length(v_student_id) NOT BETWEEN 1 AND 64
       OR v_name IS NULL OR length(v_name) NOT BETWEEN 1 AND 80
       OR v_gender IS NULL OR v_gender NOT IN ('男', '女') THEN
      RAISE EXCEPTION '名单包含无效的班级、姓名、学号或性别';
    END IF;
    IF EXISTS (SELECT 1 FROM public.dorm_students WHERE class_id = v_class_id AND (class_name <> v_class_name OR class_code <> v_class_code))
       OR EXISTS (SELECT 1 FROM public.dorm_students WHERE class_id <> v_class_id AND (class_name = v_class_name OR class_code = v_class_code)) THEN
      RAISE EXCEPTION '班级名称或填写码重复或前后不一致';
    END IF;
    INSERT INTO public.dorm_classes(class_id, class_name) VALUES (v_class_id, v_class_name)
      ON CONFLICT (class_id) DO NOTHING;
    INSERT INTO public.dorm_students(id, class_id, class_name, class_code, student_id, name, gender)
    VALUES (gen_random_uuid()::text, v_class_id, v_class_name, v_class_code, v_student_id, v_name, v_gender);
  END LOOP;

  FOR v_room IN SELECT value FROM jsonb_array_elements(p_rooms)
  LOOP
    v_number := trim(v_room->>'roomNumber');
    v_class_id := trim(v_room->>'classId');
    v_gender := trim(v_room->>'gender');
    IF v_number IS NULL OR length(v_number) NOT BETWEEN 1 AND 32
       OR v_class_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.dorm_classes WHERE class_id = v_class_id)
       OR v_gender IS NULL OR v_gender NOT IN ('男', '女')
       OR v_room->>'capacity' IS NULL OR v_room->>'capacity' <> '4' THEN
      RAISE EXCEPTION '寝室包含无效的编号、班级、性别或容量';
    END IF;
    INSERT INTO public.dorm_rooms(room_number, class_id, gender, capacity, active)
    VALUES (v_number, v_class_id, v_gender, 4, true);
  END LOOP;

  SELECT s.class_id, s.gender, count(*) AS students,
    (SELECT count(*) * 4 FROM public.dorm_rooms r WHERE r.class_id = s.class_id AND r.gender = s.gender) AS beds
  INTO v_shortage
  FROM public.dorm_students s
  GROUP BY s.class_id, s.gender
  HAVING count(*) > (SELECT count(*) * 4 FROM public.dorm_rooms r WHERE r.class_id = s.class_id AND r.gender = s.gender)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '班级 % 的 % 生床位不足：%人，%床', v_shortage.class_id, v_shortage.gender, v_shortage.students, v_shortage.beds;
  END IF;

  INSERT INTO public.dorm_audit_logs(action, uid, detail)
  VALUES ('SCHOOL_INITIALIZED', v_uid, jsonb_build_object('students', jsonb_array_length(p_students), 'rooms', jsonb_array_length(p_rooms)));
  RETURN jsonb_build_object('studentCount', jsonb_array_length(p_students), 'roomCount', jsonb_array_length(p_rooms));
END;
$$;
REVOKE ALL ON FUNCTION public.dorm_admin_initialize(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dorm_admin_initialize(jsonb, jsonb) TO authenticated, service_role;
