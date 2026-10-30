// The app's iCloud Drive container ("iCloud Drive › meerCAD", shared with the iPhone and iPad app).
// Only the system can say where it is and create it on first use, so this asks NSFileManager; in the
// sandboxed App Store build the path below the home folder is not reachable any other way.
//
//   containerPath(): Promise<string | null>   the container's Documents folder, null without iCloud
#import <Foundation/Foundation.h>
#include <node_api.h>

struct Job {
  napi_async_work work;
  napi_deferred deferred;
  NSString* path;
};

static void Execute(napi_env, void* data) {
  Job* job = static_cast<Job*>(data);
  @autoreleasepool {
    // Can take a while (it may set the container up): never on the main thread.
    NSURL* container = [[NSFileManager defaultManager] URLForUbiquityContainerIdentifier:nil];
    if (!container) return;
    NSURL* docs = [container URLByAppendingPathComponent:@"Documents" isDirectory:YES];
    [[NSFileManager defaultManager] createDirectoryAtURL:docs withIntermediateDirectories:YES attributes:nil error:nil];
    job->path = [docs.path copy];
  }
}

static void Complete(napi_env env, napi_status, void* data) {
  Job* job = static_cast<Job*>(data);
  napi_value result;
  if (job->path) napi_create_string_utf8(env, job->path.UTF8String, NAPI_AUTO_LENGTH, &result);
  else napi_get_null(env, &result);
  napi_resolve_deferred(env, job->deferred, result);
  napi_delete_async_work(env, job->work);
  delete job;
}

static napi_value ContainerPath(napi_env env, napi_callback_info) {
  Job* job = new Job{};
  napi_value promise, name;
  napi_create_promise(env, &job->deferred, &promise);
  napi_create_string_utf8(env, "icloud", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, Execute, Complete, job, &job->work);
  napi_queue_async_work(env, job->work);
  return promise;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "containerPath", NAPI_AUTO_LENGTH, ContainerPath, nullptr, &fn);
  napi_set_named_property(env, exports, "containerPath", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
