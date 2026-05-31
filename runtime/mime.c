/*
 * mime.c — MIME type detection by file extension.
 */

#include "win_compat.h"
#include "cerver.h"

#include <string.h>

#if !CERVER_PLATFORM_WINDOWS
#include <strings.h>
#endif  // !CERVER_PLATFORM_WINDOWS

#include <ctype.h>

typedef struct {
  const char* ext;
  const char* mime;
} mime_entry_t;

static const mime_entry_t mime_table[] = {
    /* Web essentials */
    {".html", "text/html; charset=utf-8"},
    {".htm", "text/html; charset=utf-8"},
    {".css", "text/css; charset=utf-8"},
    {".js", "application/javascript; charset=utf-8"},
    {".mjs", "application/javascript; charset=utf-8"},
    {".json", "application/json; charset=utf-8"},
    {".xml", "application/xml; charset=utf-8"},

    /* Text */
    {".txt", "text/plain; charset=utf-8"},
    {".csv", "text/csv; charset=utf-8"},
    {".md", "text/markdown; charset=utf-8"},

    /* Images */
    {".png", "image/png"},
    {".jpg", "image/jpeg"},
    {".jpeg", "image/jpeg"},
    {".gif", "image/gif"},
    {".svg", "image/svg+xml"},
    {".ico", "image/x-icon"},
    {".webp", "image/webp"},
    {".avif", "image/avif"},

    /* Fonts */
    {".woff", "font/woff"},
    {".woff2", "font/woff2"},
    {".ttf", "font/ttf"},
    {".otf", "font/otf"},
    {".eot", "application/vnd.ms-fontobject"},

    /* Media */
    {".mp4", "video/mp4"},
    {".webm", "video/webm"},
    {".ogg", "audio/ogg"},
    {".mp3", "audio/mpeg"},
    {".wav", "audio/wav"},

    /* Archives */
    {".zip", "application/zip"},
    {".gz", "application/gzip"},
    {".tar", "application/x-tar"},

    /* Documents */
    {".pdf", "application/pdf"},

    /* Misc */
    {".wasm", "application/wasm"},
    {".map", "application/json"},

    {NULL, NULL}};

const char* cerver_mime_from_path(const char* path) {
  if (!path) return "application/octet-stream";

  /* Find the last '.' in the path */
  const char* dot = strrchr(path, '.');
  if (!dot) return "application/octet-stream";

  /* Case-insensitive extension match */
  for (const mime_entry_t* entry = mime_table; entry->ext; entry++) {
    if (strcasecmp(dot, entry->ext) == 0) {
      return entry->mime;
    }
  }

  return "application/octet-stream";
}
