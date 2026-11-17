// Test-only dyld interposition: routine metadata must not wait for Metal.
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

extern void *MTLCreateSystemDefaultDevice(void);

static void mark(const char *variable) {
    const char *marker = getenv(variable);
    if (marker) {
        FILE *file = fopen(marker, "w");
        if (file) {
            fputs("called", file);
            fclose(file);
        }
    }
}

__attribute__((constructor)) static void loaded(void) {
    mark("STT_TEST_METAL_LOADED");
}

static void *slow_metal_device(void) {
    mark("STT_TEST_METAL_MARKER");
    sleep(3);
    return NULL;
}

__attribute__((used)) static struct {
    const void *replacement;
    const void *original;
} interposition __attribute__((section("__DATA,__interpose"))) = {
    (const void *)slow_metal_device,
    (const void *)MTLCreateSystemDefaultDevice,
};
