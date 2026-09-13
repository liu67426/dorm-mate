-- 发布后，按当前学生本人选择的前三项，仅返回室友对应的大致生活习惯概况。
CREATE OR REPLACE FUNCTION public.dorm_student_match_view()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_student_id text;
  v_room_number text;
  v_answers jsonb;
  v_priorities text[];
  v_roommates jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;

  SELECT student.id, assignment.room_number, survey.answers
  INTO v_student_id, v_room_number, v_answers
  FROM public.dorm_students AS student
  JOIN public.dorm_surveys AS survey ON survey.student_id = student.id
  JOIN public.dorm_assignments AS assignment ON assignment.student_id = student.id
  JOIN public.dorm_allocation_runs AS run ON run.id = assignment.run_id AND run.status = 'published'
  WHERE student.auth_uid = v_uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('priorities', '[]'::jsonb, 'roommates', '[]'::jsonb);
  END IF;

  v_priorities := ARRAY[
    NULLIF(v_answers->>'priority1', ''),
    NULLIF(v_answers->>'priority2', ''),
    NULLIF(v_answers->>'priority3', '')
  ];

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', roommate.name,
    'highlights', (
      SELECT jsonb_agg(jsonb_build_object(
        'label', priority.label,
        'value', CASE priority.label
          WHEN '作息时间' THEN CASE
            WHEN roommate_survey.answers->>'bedTime' IN ('22:00前', '22:00—23:00') THEN '早睡型'
            WHEN roommate_survey.answers->>'bedTime' = '01:00以后' THEN '晚睡型'
            ELSE '常规作息'
          END
          WHEN '卫生习惯' THEN CASE
            WHEN COALESCE((roommate_survey.answers->>'cleanliness')::integer, 3) >= 4 THEN '比较整洁'
            WHEN COALESCE((roommate_survey.answers->>'cleanliness')::integer, 3) <= 2 THEN '较随意'
            ELSE '一般'
          END
          WHEN '安静程度' THEN CASE
            WHEN roommate_survey.answers->>'voiceChat' IN ('经常开麦', '经常多人语音') OR roommate_survey.answers->>'speaker' = '经常外放' THEN '声音活动较多'
            WHEN roommate_survey.answers->>'voiceChat' = '偶尔开麦' OR roommate_survey.answers->>'speaker' = '白天偶尔外放' THEN '偶尔有声音'
            ELSE '偏安静'
          END
          WHEN '吸烟习惯相容' THEN CASE
            WHEN roommate_survey.answers->>'smoking' = '不抽烟' THEN '不抽烟'
            WHEN roommate_survey.answers->>'smoking' = '只在宿舍外抽烟' THEN '只在宿舍外抽烟'
            ELSE '有吸烟习惯'
          END
          WHEN '空调温度' THEN CASE
            WHEN roommate_survey.answers->>'temperature' = '23℃及以下' THEN '偏凉'
            WHEN roommate_survey.answers->>'temperature' = '28℃及以上' THEN '偏暖'
            WHEN roommate_survey.answers->>'temperature' = '不太在意' THEN '不太在意'
            ELSE '适中'
          END
          WHEN '游戏习惯' THEN CASE roommate_survey.answers->>'gamer'
            WHEN '不玩游戏' THEN '基本不玩游戏'
            WHEN '经常玩' THEN '经常玩游戏'
            WHEN '偶尔玩' THEN '偶尔玩游戏'
            ELSE '未填写'
          END
          WHEN '沟通方式' THEN COALESCE(NULLIF(roommate_survey.answers->>'conflictStyle', ''), '未填写')
          WHEN '兴趣相近' THEN CASE
            WHEN jsonb_typeof(roommate_survey.answers->'hobbies') = 'array' THEN COALESCE((
              SELECT string_agg(hobby.value, '、') FROM jsonb_array_elements_text(roommate_survey.answers->'hobbies') AS hobby(value)
            ), '未填写')
            ELSE COALESCE(NULLIF(roommate_survey.answers->>'hobbies', ''), '未填写')
          END
          ELSE '未填写'
        END
      ) ORDER BY priority.rank)
      FROM unnest(v_priorities) WITH ORDINALITY AS priority(label, rank)
      WHERE priority.label IS NOT NULL
    )
  ) ORDER BY roommate.name), '[]'::jsonb)
  INTO v_roommates
  FROM public.dorm_assignments AS roommate_assignment
  JOIN public.dorm_students AS roommate ON roommate.id = roommate_assignment.student_id
  JOIN public.dorm_surveys AS roommate_survey ON roommate_survey.student_id = roommate.id
  WHERE roommate_assignment.room_number = v_room_number
    AND roommate.id <> v_student_id;

  RETURN jsonb_build_object(
    'priorities', to_jsonb(array_remove(v_priorities, NULL)),
    'roommates', v_roommates
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dorm_student_match_view() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dorm_student_match_view() TO authenticated, service_role;
