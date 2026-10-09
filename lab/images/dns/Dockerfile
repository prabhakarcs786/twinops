FROM coredns/coredns:1.11.3 AS coredns

FROM alpine:3.20
RUN apk add --no-cache iproute2
COPY --from=coredns /coredns /usr/bin/coredns
ENTRYPOINT ["/usr/bin/coredns", "-conf", "/etc/coredns/Corefile"]
