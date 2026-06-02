# Published nginx image for DiscordWatchParty — bundles the routing config so
# hosts don't need to bind-mount it. Build context is this nginx/ directory.
FROM nginx:alpine
COPY default.conf /etc/nginx/conf.d/default.conf
