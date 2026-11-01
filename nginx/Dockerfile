# nginx-rtmp + ffmpeg with the relay's config and ingest scripts baked in, so
# production needs no bind mounts. Build context: the repository root.
FROM alfg/nginx-rtmp:latest
# The base image is Alpine without bash or curl; the ingest scripts use both
# (#!/usr/bin/env bash, and curl for the stats call).
RUN apk add --no-cache bash curl
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY scripts /opt/tuberadio/scripts
RUN chmod +x /opt/tuberadio/scripts/*.sh
# The base image's default command renders /etc/nginx/nginx.conf from its own
# template at start, which would replace the config above. Start nginx directly.
CMD ["nginx", "-g", "daemon off;"]
