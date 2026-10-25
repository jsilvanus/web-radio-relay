# nginx-rtmp + ffmpeg with the relay's config and ingest scripts baked in, so
# production needs no bind mounts. Build context: the repository root.
FROM alfg/nginx-rtmp:latest
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY scripts /opt/tuberadio/scripts
RUN chmod +x /opt/tuberadio/scripts/*.sh
