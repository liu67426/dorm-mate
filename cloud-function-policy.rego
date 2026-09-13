package authz.user

default allow := false

# 网关只放通云函数入口。没有登录 UID 的请求会被 dorm-api 立即拒绝；
# 学生名单核验与辅导员 UID 权限也都在 dorm-api 内再次检查。
allow if input.cloudbase.resource_type == "functions"
