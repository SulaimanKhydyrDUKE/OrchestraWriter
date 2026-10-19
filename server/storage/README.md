# server/storage/

S3 access. The server never streams audio bytes. It signs URLs and the browser talks to S3 directly.

- `s3Client.ts`: one `S3Client`, credentials from the SDK default chain (your `~/.aws` locally, the App Runner instance role in production).
- `audio.ts`: `newAudioKey` (keys are `users/<id>/<uuid>-<name>`, so the prefix is the ownership check), `presignUpload` (PUT, 15 min, Content-Type pinned), `presignDownload` (GET, 15 min), `deleteAudio`.

The bucket blocks all public access; the only way in is a presigned URL. Its CORS rule must list the site origin, which `scripts/s3-init.sh` sets.
