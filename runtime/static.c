/*
 * static.c — Static file serving for the cerver runtime.
 *
 * In embedded mode, serves from the compiled-in asset array.
 * In external mode, serves from the filesystem (public/ directory).
 * Supports pre-compressed gzip/brotli variants and cache headers.
 */

#include "cerver.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

/* ------------------------------------------------------------------ */
/*  Path safety: prevent directory traversal                          */
/* ------------------------------------------------------------------ */

static int path_is_safe(const char *path) {
    /* Reject paths with ".." */
    if (strstr(path, "..")) return 0;

    /* Reject paths with null bytes */
    if (memchr(path, '\0', strlen(path))) return 0;

    /* Must start with "/" */
    if (path[0] != '/') return 0;

    return 1;
}

/* ------------------------------------------------------------------ */
/*  Accept-Encoding parsing                                           */
/* ------------------------------------------------------------------ */

typedef struct {
    int accepts_gzip;
    int accepts_br;
} encoding_prefs_t;

static encoding_prefs_t parse_accept_encoding(const cerver_request_t *req) {
    encoding_prefs_t prefs = { 0, 0 };
    const char *ae = cerver_req_header(req, "Accept-Encoding");
    if (!ae) return prefs;

    if (strstr(ae, "br")) prefs.accepts_br = 1;
    if (strstr(ae, "gzip")) prefs.accepts_gzip = 1;

    return prefs;
}

/* ------------------------------------------------------------------ */
/*  Cache header helper                                               */
/* ------------------------------------------------------------------ */

static void add_cache_headers(cerver_response_t *res, const char *path) {
    /* Hashed/versioned assets (in /static/) get long cache */
    if (strstr(path, "/static/") || strstr(path, "/assets/")) {
        cerver_res_header(res, "Cache-Control", "public, max-age=31536000, immutable");
    } else {
        /* HTML and other top-level files get short cache with revalidation */
        cerver_res_header(res, "Cache-Control", "public, max-age=3600, must-revalidate");
    }
}

/* ------------------------------------------------------------------ */
/*  Serve from embedded assets                                        */
/* ------------------------------------------------------------------ */

static int serve_embedded(cerver_server_t *srv, cerver_request_t *req,
                          cerver_response_t *res) {
    if (!srv->assets || srv->asset_count == 0) return -1;

    const char *path = req->path;
    const cerver_asset_t *found = NULL;

    /* Try exact match first */
    for (int i = 0; i < srv->asset_count; i++) {
        if (strcmp(srv->assets[i].path, path) == 0) {
            found = &srv->assets[i];
            break;
        }
    }

    /* Try with /index.html appended (for directory-like paths) */
    if (!found) {
        char index_path[CERVER_MAX_PATH];
        if (path[strlen(path) - 1] == '/') {
            snprintf(index_path, sizeof(index_path), "%sindex.html", path);
        } else {
            snprintf(index_path, sizeof(index_path), "%s/index.html", path);
        }

        for (int i = 0; i < srv->asset_count; i++) {
            if (strcmp(srv->assets[i].path, index_path) == 0) {
                found = &srv->assets[i];
                break;
            }
        }
    }

    if (!found) return -1;

    /* Check for pre-compressed variants */
    encoding_prefs_t enc = parse_accept_encoding(req);

    if (enc.accepts_br && found->data_br && found->data_br_len > 0) {
        /* Serve brotli */
        cerver_res_file(res, 200, found->mime_type,
                       found->data_br, found->data_br_len);
        cerver_res_header(res, "Content-Encoding", "br");
        cerver_res_header(res, "Vary", "Accept-Encoding");
    } else if (enc.accepts_gzip && found->data_gz && found->data_gz_len > 0) {
        /* Serve gzip */
        cerver_res_file(res, 200, found->mime_type,
                       found->data_gz, found->data_gz_len);
        cerver_res_header(res, "Content-Encoding", "gzip");
        cerver_res_header(res, "Vary", "Accept-Encoding");
    } else {
        /* Serve uncompressed */
        cerver_res_file(res, 200, found->mime_type,
                       found->data, found->data_len);
    }

    add_cache_headers(res, found->path);

    return 0;
}

/* ------------------------------------------------------------------ */
/*  Serve from filesystem                                             */
/* ------------------------------------------------------------------ */

static int serve_filesystem(cerver_server_t *srv, cerver_request_t *req,
                            cerver_response_t *res) {
    if (!srv->public_dir) return -1;

    const char *path = req->path;
    if (!path_is_safe(path)) return -1;

    /* Build the full filesystem path */
    char full_path[CERVER_MAX_PATH * 2];
    snprintf(full_path, sizeof(full_path), "%s%s", srv->public_dir, path);

    /* Check if it's a directory — try index.html */
    struct stat st;
    if (stat(full_path, &st) == 0 && S_ISDIR(st.st_mode)) {
        snprintf(full_path, sizeof(full_path), "%s%s/index.html",
                 srv->public_dir, path);
        if (stat(full_path, &st) != 0) return -1;
    }

    /* Must be a regular file */
    if (stat(full_path, &st) != 0 || !S_ISREG(st.st_mode)) {
        return -1;
    }

    /* Read the file */
    FILE *fp = fopen(full_path, "rb");
    if (!fp) return -1;

    size_t file_size = (size_t)st.st_size;
    char *file_data = malloc(file_size);
    if (!file_data) {
        fclose(fp);
        return -1;
    }

    size_t bytes_read = fread(file_data, 1, file_size, fp);
    fclose(fp);

    if (bytes_read != file_size) {
        free(file_data);
        return -1;
    }

    /* Determine MIME type */
    const char *mime = cerver_mime_from_path(full_path);

    res->status = 200;
    res->content_type = mime;
    res->body = file_data;
    res->body_len = file_size;
    res->_body_owned = 1; /* We malloc'd this */

    add_cache_headers(res, path);

    return 0;
}

/* ------------------------------------------------------------------ */
/*  Main static serving entry point                                   */
/* ------------------------------------------------------------------ */

int cerver_serve_static(cerver_server_t *srv, cerver_request_t *req,
                        cerver_response_t *res) {
    /* Only serve GET requests for static files */
    if (strcmp(req->method, "GET") != 0) return -1;

    /* Try embedded assets first */
    if (serve_embedded(srv, req, res) == 0) return 0;

    /* Fall back to filesystem */
    if (serve_filesystem(srv, req, res) == 0) return 0;

    return -1;
}
