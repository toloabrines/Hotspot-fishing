revoke execute on function public.has_module_access(uuid, text, text) from public;
revoke execute on function public.has_module_access(uuid, text, text) from anon;
revoke execute on function public.has_module_access(uuid, text, text) from authenticated;
grant execute on function public.has_module_access(uuid, text, text) to service_role;
