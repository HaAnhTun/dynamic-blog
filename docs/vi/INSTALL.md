# Cài đặt

Blog Engine chạy bằng ba container (PostgreSQL, API Spring Boot, site Next.js) từ một tệp `docker-compose.yml`, cộng thêm container
thứ tư không bắt buộc cho tìm kiếm. Trang này đưa bạn từ một máy trống tới một site đang chạy, rồi tới một site công khai có TLS.
Bản tiếng Anh: [../INSTALL.md](../INSTALL.md).

## Nội dung

- [Yêu cầu](#yêu-cầu)
- [Bắt đầu nhanh](#bắt-đầu-nhanh)
- [Image backend dựng sẵn hoặc build từ mã nguồn](#image-backend-dựng-sẵn-hoặc-build-từ-mã-nguồn)
- [init-env làm gì](#init-env-làm-gì)
- [Triển khai lên VPS](#triển-khai-lên-vps)
- [TLS với Caddy](#tls-với-caddy)
- [TLS với nginx và certbot](#tls-với-nginx-và-certbot)
- [Tuỳ chọn: đăng nhập GitHub cho độc giả](#tuỳ-chọn-đăng-nhập-github-cho-độc-giả)
- [Tuỳ chọn: gửi email newsletter](#tuỳ-chọn-gửi-email-newsletter)
- [Tuỳ chọn: tìm kiếm bằng Meilisearch](#tuỳ-chọn-tìm-kiếm-bằng-meilisearch)
- [Sau khi cài đặt](#sau-khi-cài-đặt)

## Yêu cầu

| | |
|---|---|
| Docker | Docker Engine có plugin Compose (lệnh `docker compose`, phiên bản 2). Docker Desktop trên Windows và macOS dùng được. |
| Bộ nhớ | **Máy chủ có ít nhất 2 GB RAM.** Các container bị giới hạn ở 384m (PostgreSQL), 768m (backend, `BACKEND_MEM_LIMIT`), 384m (frontend) và 512m (Meilisearch, chỉ khi bạn bật). Ảnh tải lên được giải mã trong heap của backend, nên máy nhỏ hơn thì ảnh lớn càng dễ làm hết bộ nhớ. |
| Ổ đĩa | Postgres chứa bài viết và ảnh (ảnh tính vào `MEDIA_MAX_TOTAL_SIZE`, mặc định 1GB), cộng với các image Docker. |
| Mạng | Với site công khai: một tên miền có DNS trỏ về máy chủ, và cổng 80 và 443 mở. Bản thân site chỉ lắng nghe trên `127.0.0.1:3000`. |

Bạn **không** cần JDK, Node.js hay Maven để chạy site; Docker build hoặc kéo các image. Những thứ đó dành cho
[phát triển](../DEVELOPMENT.md).

## Bắt đầu nhanh

Trên một máy, để thử tại `http://localhost:3000`. Từ thư mục gốc của repository:

```bash
./scripts/init-env.sh
```

Lệnh này ghi `.env` với các bí mật ngẫu nhiên. Trên Windows PowerShell hãy chạy `.\scripts\init-env.ps1`. Sau đó build và khởi động:

```bash
docker compose up -d --build
```

Lần build đầu tải các image nền và biên dịch cả hai ứng dụng; mất vài phút. Khi xong, đợi site trả lời:

```bash
curl -fsS --retry 40 --retry-delay 5 --retry-connrefused -o /dev/null http://localhost:3000/setup
```

Mở <http://localhost:3000/setup>. Một bản cài mới không có mật khẩu nào dùng được: bạn nhận quyền sở hữu bằng **mã thiết lập** mà
backend ghi vào một tệp, như mô tả ở [FIRST-RUN.md](FIRST-RUN.md). Đọc mã bằng:

```bash
docker compose exec backend sh -c 'cat /data/setup-code'
```

(Trong một script không có terminal, thêm `-T`: `docker compose exec -T backend sh -c 'cat /data/setup-code'`.)

Để xem cái gì đang chạy: `docker compose ps`; xem log: `docker compose logs -f backend`. Để dừng: `docker compose down` (dữ liệu vẫn
nằm trong các volume có tên); `docker compose down -v` xoá các volume, và cùng với đó là mọi bài viết và ảnh.

## Image backend dựng sẵn hoặc build từ mã nguồn

`docker-compose.yml` đặt tên cho hai image, `BACKEND_IMAGE` và `FRONTEND_IMAGE`, và vẫn giữ phần `build:` trên mỗi service. Giá trị
mặc định là tên chỉ dùng trên máy (`blog-engine-backend:local` và `blog-engine-frontend:local`), có chủ ý: nếu mặc định ghi tên một
tài khoản trên registry thì `docker compose pull` sẽ kéo về bất cứ thứ gì tài khoản đó đăng, mà container backend giữ mật khẩu
database, `JWT_SECRET` và các khoá gửi mail, đăng nhập. Với giá trị mặc định, lệnh pull không tìm thấy gì và báo lỗi, tức là an
toàn. Từ đó có hai cách:

| | Lệnh | Dùng khi |
|---|---|---|
| Build từ mã nguồn | `docker compose up -d --build` | Mọi lần triển khai thật. Lệnh build cả hai image từ bản checkout của bạn với `.env` của bạn và gắn tag bằng các tên đó. |
| Image backend dựng sẵn | đặt `BACKEND_IMAGE` trong `.env` (bên dưới), rồi `docker compose pull backend`, `docker compose build frontend` và `docker compose up -d` | Bạn muốn kéo backend về thay vì build. Frontend luôn được build tại chỗ. |

Workflow phát hành đẩy image **backend** lên `ghcr.io` cho `linux/amd64` và `linux/arm64` khi một tag phiên bản được đẩy lên, dưới
tài khoản sở hữu repository tạo ra bản phát hành: `ghcr.io/<tài khoản>/blog-engine-backend`.
Để dùng nó, đặt `BACKEND_IMAGE` trong `.env` về namespace đó, **và ghim phiên bản**: một tag phiên bản
(`ghcr.io/<tài khoản>/blog-engine-backend:1.2.3`) hoặc tốt hơn là một digest
(`ghcr.io/<tài khoản>/blog-engine-backend@sha256:<digest>`, in ra bởi `docker buildx imagetools inspect <image>:<tag>`). Đừng dựa vào
`latest` hay `1.2`: chúng đổi theo từng bản phát hành, nên cùng một `.env` tháng sau có thể kéo về mã khác. Lấy `<tài khoản>` từ
repository bạn tin tưởng, không lấy từ một ví dụ. Một bản tiền phát hành như `1.0.0-rc.1` chỉ có tag của chính nó và **không có
`latest`**.

**Kiểm tra chữ ký trước khi tin một digest.** Trước khi workflow phát hành đẩy bất kỳ thứ gì lên, Trivy quét image backend (không có
lỗ hổng HIGH hay CRITICAL nào đã có bản sửa); sau khi đẩy lên, workflow ký digest của image bằng
[cosign](https://docs.sigstore.dev/cosign/overview/), kiểu keyless: không có khoá nào để bị đánh cắp, chứng chỉ ghi rõ lần chạy
workflow và chữ ký được lưu trong nhật ký công khai của Sigstore. Với cosign 3 trở lên (workflow ký và kiểm tra bằng cosign 3, bản
này lưu chữ ký theo định dạng bundle mới của Sigstore; client cũ hơn có thể không tìm thấy chữ ký), thay `<tài khoản>` và
`<repository>` bằng tài khoản và repository bạn tin tưởng:

```bash
cosign verify ghcr.io/<tài khoản>/blog-engine-backend@sha256:<digest> \
  --certificate-identity-regexp '^https://github\.com/<tài khoản>/<repository>/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Lệnh chỉ thành công với image mà workflow `release.yml` của repository đó đã ký trên một tag `v*`. Hãy đặt digest đã qua kiểm tra
vào `.env` (`BACKEND_IMAGE=ghcr.io/<tài khoản>/blog-engine-backend@sha256:<digest>`), không dùng tag. Chữ ký cho biết ai đã build
image, không bảo đảm mã trong đó không có lỗi; còn image bạn tự build bằng `docker compose up -d --build` thì không cần kiểm tra này.

**Không có image frontend xuất bản: hãy tự build.** `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_DEFAULT_LOCALE` và `HSTS_MAX_AGE` được biên
dịch vào bundle Next lúc build image, nên một image dựng sẵn chỉ có thể mang `http://localhost:3000` (ngôn ngữ mặc định `en`, HSTS
86400). Khi đó URL chuẩn (canonical), thẻ Open Graph và sitemap trên một site công khai đều ghi `localhost`, site https không gửi
`Strict-Transport-Security`, mà không có lỗi nào báo cho bạn. Vì vậy frontend luôn được build từ bản checkout của bạn với `.env`
của site:

```bash
docker compose build frontend
docker compose up -d
```

Quy tắc này áp dụng mỗi khi bạn đổi `SITE_URL`, `DEFAULT_LOCALE` hoặc `HSTS_MAX_AGE`: build lại frontend bằng
`docker compose up -d --build`. Frontend cũng tự kiểm tra: image ghi lại địa chỉ nó được build cho, compose đưa `SITE_URL` của `.env`
vào container, và container **từ chối khởi động** khi hai giá trị khác nhau (log nói rõ hai địa chỉ và điều gì sẽ sai), nên việc quên
`--build` làm dừng đợt triển khai thay vì phục vụ một site ghi sai địa chỉ. Nếu bạn thật sự muốn chạy image dưới một địa chỉ khác, đặt
`ALLOW_SITE_URL_MISMATCH=true` trong `.env`: khi đó nó khởi động và ghi cùng nội dung như một cảnh báo. Lệnh `docker run` trần của
image (không có `SITE_URL`) khởi động như trước.

## init-env làm gì

`scripts/init-env.sh` (Linux, macOS, Git Bash) và `scripts/init-env.ps1` (Windows PowerShell) sao chép `.env.example` thành `.env`
và điền các bí mật bằng giá trị ngẫu nhiên: `DB_PASSWORD`, `JWT_SECRET`, `MFA_ENCRYPTION_KEY`, `VIEWS_TOKEN`, `CLIENT_IP_TOKEN`, `NEWSLETTER_SECRET`,
`MEILI_MASTER_KEY`, cùng mật khẩu của ba vai trò cơ sở dữ liệu (`DB_OWNER_PASSWORD`, `DB_ADMIN_PASSWORD`). Hai
script in ra những gì đã làm và không bao giờ in một bí mật, và tạo `.env` chỉ riêng bạn đọc được: chế độ 600 với script shell (script này
cũng không đặt bí mật nào lên dòng lệnh của các chương trình nó chạy), quyền chỉ chủ sở hữu và không kế thừa với script PowerShell
trên Windows. Chúng từ chối ghi đè `.env` đã có (mã thoát 1): hãy dời nó đi trước. Có
ba đầu vào, đều không bắt buộc:

```bash
SITE_URL=https://example.com SITE_PORT=3000 DEFAULT_LOCALE=vi ./scripts/init-env.sh
```

```powershell
.\scripts\init-env.ps1 -SiteUrl https://example.com -SitePort 3000 -DefaultLocale vi
```

`SITE_URL` là origin công khai (mặc định `http://localhost:3000`), `SITE_PORT` là cổng của site trên máy chủ (mặc định `3000`),
`DEFAULT_LOCALE` là ngôn ngữ có URL không có tiền tố, `en` (mặc định) hoặc `vi`. `ADMIN_PASSWORD`, `SETUP_TOKEN`,
`ADMIN_GITHUB_ID`, `MFA_ENROLLMENT_TOKEN`, `MFA_RESET_EMAIL` và `MFA_RESET_TOKEN` cố ý để trống. Bạn cũng có thể tự sao chép `.env.example` và tự điền mọi bí mật; compose từ chối khởi động nếu
thiếu `DB_PASSWORD`, `JWT_SECRET`, `MFA_ENCRYPTION_KEY`, `SITE_URL`, `VIEWS_TOKEN` hoặc `CLIENT_IP_TOKEN` (`MFA_ENCRYPTION_KEY`: `openssl rand -base64 32`,
và giữ một bản sao ngoài máy chủ). `.env.example` đặt tên cho vai trò chủ sở hữu và vai trò quản trị của cơ sở dữ liệu, nên
`DB_OWNER_PASSWORD` và `DB_ADMIN_PASSWORD` cũng bắt buộc, mỗi mật khẩu khác `DB_PASSWORD` và khác nhau (nếu không, container postgres từ chối
khởi động và nói lý do trong `docker compose logs postgres`); xóa các dòng OWNER và ADMIN nếu bạn chạy kiểu một vai trò. Mọi biến được giải thích trong
[CONFIGURATION.md](../CONFIGURATION.md) (tiếng Anh).

## Triển khai lên VPS

Site được thiết kế cho một máy chủ nhỏ. Tệp compose chỉ công bố đúng một cổng, frontend trên `127.0.0.1:3000`, nên một reverse
proxy trên cùng máy là con đường duy nhất từ internet vào. PostgreSQL và backend hoàn toàn không được công bố, vì trình duyệt không
bao giờ gọi API trực tiếp: máy chủ Next làm việc đó. Bên trong Docker, PostgreSQL nằm trên một mạng nội bộ mà chỉ
backend tham gia (frontend không mở được kết nối tới nó), và mọi container chạy không có capability Linux, không thể tăng đặc quyền, với
hệ thống tệp gốc chỉ đọc và giới hạn số tiến trình (xem "Containers and networks" trong docs/SECURITY.md).

1. **Chuẩn bị máy.** Cài Docker, trỏ tên miền của bạn (và `www`, nếu dùng) về máy chủ, cho phép cổng 80 và 443 và không gì khác từ
   bên ngoài. Đừng công bố cổng 3000: Docker mở các cổng được công bố bằng quy tắc tường lửa riêng của nó mà `ufw` không chặn
   được, và một client chạm thẳng vào Next có thể giả mạo `X-Forwarded-For` (khoá của mọi giới hạn theo IP) và bỏ qua các giới hạn
   kích thước body của proxy.
2. **Ghi `.env` với origin công khai của bạn:**

   ```bash
   SITE_URL=https://example.com ./scripts/init-env.sh
   ```

   Hãy dùng `https://`: cookie phiên mang cờ `secure` ở môi trường production, nên qua HTTP thường thì trình duyệt bỏ chúng và việc
   đăng nhập lặng lẽ không làm gì. Dùng đúng host thật, không có dấu gạch chéo cuối và không có đường dẫn.
3. **Build và khởi động:** `docker compose up -d --build`. Một `SITE_URL` công khai cũng bật các kiểm tra lúc khởi động của
   backend: `JWT_SECRET` dùng cho phát triển, `VIEWS_TOKEN` hoặc `CLIENT_IP_TOKEN` để trống, hoặc một tài khoản quản trị dùng mật khẩu
   phát triển sẽ khiến backend từ chối khởi động. `init-env` cho bạn các giá trị an toàn.
4. **Đặt một reverse proxy phía trước** có TLS: [Caddy](#tls-với-caddy) (chứng chỉ tự động) hoặc
   [nginx với certbot](#tls-với-nginx-và-certbot). Cả hai ví dụ đều chuyển hướng `www` về host chính, áp dụng giới hạn kích thước
   body và giữ các token dùng một lần cùng từ khoá tìm kiếm ra khỏi access log.
5. **Nhận quyền sở hữu site** tại `https://example.com/setup` ([FIRST-RUN.md](FIRST-RUN.md)).

Mặc định của một bản cài production và cách đổi:

| | Mặc định | Đổi |
|---|---|---|
| Cổng frontend | `127.0.0.1:3000` | `SITE_PORT` (một số), `SITE_BIND` (địa chỉ). Chỉ đặt `SITE_BIND=0.0.0.0` khi proxy nằm trên máy khác, và khi đó hãy dùng tường lửa chỉ cho phép máy đó vào cổng này. |
| Swagger UI, `/v3/api-docs` | tắt | `SPRINGDOC_ENABLED=true` (compose đặt `false` một cách tường minh). |
| Đăng nhập quản trị bằng mật khẩu | 10 lần mỗi 10 phút cho mỗi IP (ở Next) và 20 lần mỗi 10 phút cho mỗi địa chỉ client (ở backend); backend chỉ kiểm tra vài mật khẩu cùng lúc | Cố định. Nếu bạn bị chặn nhầm, hãy đợi, đăng nhập từ mạng khác, hoặc `docker compose restart frontend` (bộ đếm nằm trong bộ nhớ). |
| Form liên hệ, newsletter, làm mới phiên, thiết lập lần đầu, tìm kiếm | Giới hạn theo địa chỉ client ở Next và một lần nữa ở backend, cộng thêm một trần chung cho cả site với form liên hệ, email newsletter và tìm kiếm. Cần `CLIENT_IP_TOKEN`, bí mật giúp backend tin địa chỉ mà Next chuyển tới | Các con số là thuộc tính `app.rate-limit.*` ([CONFIGURATION.md](../CONFIGURATION.md#rate-limits), tiếng Anh). |
| Lượt xem | 30 beacon mỗi phút cho mỗi IP, cần `VIEWS_TOKEN` | Cố định. |
| Newsletter | `NEWSLETTER_TRANSPORT=log`: nhận đăng ký, không gửi email | [Tuỳ chọn: gửi email newsletter](#tuỳ-chọn-gửi-email-newsletter). |
| HSTS | `max-age=86400` khi `SITE_URL` là https | `HSTS_MAX_AGE`, lúc build image. |
| Log | tối đa 3 tệp 10 MB cho mỗi container | Sửa `x-logging` trong `docker-compose.yml`, hoặc chuyển log ra khỏi máy để một đợt request dồn dập không đẩy các dòng bảo mật ra khỏi cửa sổ log ([Security](../SECURITY.md#audit-events)). |

Phía sau proxy, `TRUSTED_PROXY_HOPS` phải bằng số proxy đứng trước Next: `1` nếu chỉ có Caddy hoặc nginx (mặc định). Khi có
Cloudflare đứng trước, hãy giữ `1` và để nginx khôi phục địa chỉ của khách ([Phía sau Cloudflare](#phía-sau-cloudflare)); chỉ đặt `2`
nếu origin chỉ nhận kết nối từ Cloudflare. Địa chỉ được chọn ra cũng là địa chỉ Next chuyển cho backend để backend áp giới hạn theo địa chỉ của
riêng nó, kèm `CLIENT_IP_TOKEN` (cùng một giá trị ở cả hai phía; compose và `init-env` lo việc này). Nếu hai phía không có cùng
`CLIENT_IP_TOKEN`, backend coi máy chủ Next là một người gọi duy nhất cho mọi độc giả.

### Phía sau Cloudflare

Mọi giới hạn theo IP, ở Next lẫn ở backend, đếm địa chỉ nằm ở mục `TRUSTED_PROXY_HOPS` tính từ bên phải của `X-Forwarded-For`. nginx
nối thêm vào những gì người gọi đã gửi, nên mục đó chỉ là địa chỉ của khách khi yêu cầu thật sự đi qua Cloudflare. Người gọi thẳng
vào origin (địa chỉ bị lộ, hoặc chưa từng được giấu) sẽ tự chọn khóa của mình và xoay vòng được mọi giới hạn theo địa chỉ; vì vậy hai
hop **không** phải giá trị để chép mù quáng. Hãy làm một trong hai cách sau, cách đầu an toàn hơn vì vẫn đúng ngay cả khi origin bị
gọi thẳng:

1. **Giữ `TRUSTED_PROXY_HOPS=1` và khôi phục địa chỉ của khách ngay trong nginx** bằng `ngx_http_realip_module`, chỉ tin
   `CF-Connecting-IP` từ các dải địa chỉ Cloudflare công bố. Yêu cầu đến từ địa chỉ khác không được tin: nginx giữ `$remote_addr` của
   chính nó, và đó là giá trị Next đọc. Tạo tệp một lần, làm mới khi Cloudflare đổi dải (danh sách ở
   <https://www.cloudflare.com/ips-v4> và <https://www.cloudflare.com/ips-v6>):

   ```bash
   { for range in $(curl -fsS https://www.cloudflare.com/ips-v4; echo; curl -fsS https://www.cloudflare.com/ips-v6); do
       echo "set_real_ip_from $range;"
     done
     echo "real_ip_header CF-Connecting-IP;"
   } | sudo tee /etc/nginx/cloudflare-realip.conf
   ```

   Sau đó bỏ dấu `#` ở dòng `include /etc/nginx/cloudflare-realip.conf;` trong khối host chính của `deploy/nginx.conf.example` rồi
   `sudo nginx -t && sudo systemctl reload nginx`. Nếu thiếu một dải trong tệp, mọi yêu cầu từ phần đó của Cloudflare sẽ bị tính là
   một khách duy nhất.
2. **Chỉ dùng `TRUSTED_PROXY_HOPS=2` khi origin chỉ nhận kết nối từ Cloudflare**, để không ai khác gửi được header đó: quy tắc tường
   lửa chỉ cho các dải của Cloudflare vào cổng 443, Authenticated Origin Pulls của Cloudflare (nginx: `ssl_client_certificate` với CA
   origin-pull của Cloudflare và `ssl_verify_client on`), hoặc Cloudflare Tunnel để origin không mở cổng công khai nào.

Dù chọn cách nào, cũng nên chỉ cho origin nhận từ Cloudflare: như vậy mọi yêu cầu đều đi qua các quy tắc của Cloudflare (WAF, rate
rule, cache).

### Header bảo mật

Chính Next gửi các header bảo mật, nên proxy không được thêm chúng (thêm dòng thứ hai nghĩa là có hai header): `X-Frame-Options: DENY`,
`Content-Security-Policy` (chính sách đầy đủ, được áp dụng thật, đã gồm `frame-ancestors 'none'`; xem `docs/SECURITY.md`), `Reporting-Endpoints`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`
(`no-referrer` dưới `/api/auth/github/*` và `/newsletter/*`), `Permissions-Policy: camera=(), microphone=(), geolocation=()`, không
có `X-Powered-By`, và `Strict-Transport-Security` khi `SITE_URL` là https. **Đừng thêm `Strict-Transport-Security` ở proxy:** phản
hồi sẽ mang hai header HSTS, trình duyệt chỉ đọc header đầu và `HSTS_MAX_AGE` có thể không còn tác dụng. Mặc định là một ngày, có
chủ ý; chỉ nâng `HSTS_MAX_AGE` lên `31536000` sau khi HTTPS đã chạy ổn định ([Nâng HSTS](#nâng-hsts-khi-https-đã-ổn-định)).

### Nâng HSTS khi HTTPS đã ổn định

Mặc định một ngày nghĩa là nếu cấu hình HTTPS của bạn sai thì người đọc chỉ bị khoá ngoài đến ngày mai, nhưng cũng nghĩa là lớp bảo vệ
ngắn: người không vào site một ngày lại có thể bị hạ cấp về http. ASVS yêu cầu ít nhất một năm. Vì vậy đây là một bước có mốc thời
gian của việc cài đặt, không phải thứ để tự nhớ: khoảng **hai tuần** sau lần chạy công khai đầu tiên, khi chứng chỉ đã gia hạn (hoặc
bạn biết chắc nó sẽ gia hạn), mọi trang đều mở được qua https và không có gì cần http thường, hãy làm một lần:

1. Trong `.env` đặt `HSTS_MAX_AGE=31536000`.
2. Chỉ khi bạn sở hữu mọi subdomain của host và tất cả đều chạy https, đặt thêm `HSTS_INCLUDE_SUBDOMAINS=true`. Một subdomain không có
   HTTPS chạy đúng sẽ không truy cập được trong cả thời gian max-age, nên còn nghi ngờ thì để tắt. Cố ý không có công tắc `preload`:
   danh sách preload của trình duyệt gần như không thể rút ra.
3. `docker compose up -d --build` (cả hai giá trị được biên dịch vào image frontend).
4. Kiểm tra header: `curl -sI https://<domain>/ | grep -i strict-transport-security` hiện `max-age=31536000`.

Lúc build, frontend in một dòng (`[hsts] ...`) mỗi khi max-age dưới một năm để nhắc bạn. `HSTS_MAX_AGE=0` là đường lui: trình duyệt
sẽ quên chính sách ở lần truy cập https tiếp theo.

### Giới hạn kích thước body và vì sao chúng quan trọng

Cả hai ví dụ cho phép 1 MB cho mọi thứ và 6 MB cho `/admin/`. Các trang công khai gửi tối đa 16 KB, trong khi việc tải ảnh lên của
trang quản trị POST tới 5 MiB vào URL trang `/admin/...`. Next đọc mọi POST multipart tới mọi trang tới 5 MiB trước khi biết đó có
phải một action hợp lệ hay không, nên proxy là nơi chặn các POST rác. Backend cũng tự giới hạn JSON nó đọc (64 KiB cho API công khai, 6 MiB
dưới `/api/v1/admin/`, vượt thì 413): phía sau các proxy này nó không bao giờ nhận nhiều hơn mức proxy cho qua, và đó là giới hạn duy nhất của
một backend chạy trên URL công khai riêng. Các lớp khác nằm ở
[Upload size limits](../CONFIGURATION.md#upload-size-limits-by-layer).

### Giới hạn tốc độ request

Next giới hạn các lần đọc tốn kém theo từng địa chỉ ([SECURITY.md](../SECURITY.md#rate-limits), tiếng Anh), nhưng chỉ proxy mới chặn được một
request trước khi nó tốn của Next bất cứ điều gì, và một địa chỉ bài viết, ảnh hay thẻ chia sẻ bịa ra tốn một lần render, một lần đọc cơ
sở dữ liệu hoặc một ảnh PNG phải vẽ. Cả hai ví dụ trả `405` cho `TRACE`, `TRACK` và `CONNECT` (không có nó, Next ném lỗi 500 và ghi stack
trace cho mỗi request). Ví dụ nginx đi xa hơn, và có ba khối để sao chép:

- hai dòng `limit_req_zone` (trang: 20 request mỗi giây mỗi địa chỉ với burst 100; các lần đọc tốn kém: 5 mỗi giây với burst từ 10 đến 60)
  và `limit_req_status 429`, đặt ngoài mọi khối server;
- một `proxy_cache_path` và ba location: `/media/` và `/_next/image` giữ phản hồi 200 trong một giờ, `/api/og/` (thẻ chia sẻ) trong năm
  phút, nên một đợt request dồn dập cho cùng một ảnh chỉ còn là một request tới Next. `/media/` được khóa chỉ theo đường dẫn, vì route của
  nó bỏ qua query string và `/media/<id>.jpg?x=<ngẫu nhiên>` phải tìm thấy bản đã cache; `/_next/image` giữ query trong khóa, vì query chính
  là ảnh, độ rộng và chất lượng. Thẻ chỉ giữ năm phút vì thẻ của một địa chỉ từng được hỏi trước khi bài tồn tại là thẻ chung của cả trang,
  và một bài đã đổi tiêu đề không nên giữ thẻ cũ cả giờ. Tạo thư mục trước: `sudo mkdir -p /var/cache/nginx/blog`. Ảnh đã xóa rời khỏi cache
  này trong vòng một giờ;
- một location cho feed và sitemap có giới hạn nhưng không cache (bài đã gỡ phải biến mất khỏi chúng ngay), và một location cho
  `/_next/static/` không giới hạn cũng không cache, vì mỗi trang tải hàng chục tệp cùng lúc.

`$binary_remote_addr` là địa chỉ mà nginx nhìn thấy. Khi Cloudflare đứng trước nginx, đó là địa chỉ của Cloudflare, nên mọi độc giả dùng chung
một giới hạn cho đến khi bạn khôi phục địa chỉ của độc giả bằng `set_real_ip_from` (các dải của Cloudflare) và `real_ip_header CF-Connecting-IP`.
Caddy không có giới hạn tốc độ và cache nếu không có plugin (ví dụ `mholt/caddy-ratelimit`, build bằng xcaddy): hãy đặt cùng các con số vào đó,
hoặc đặt trước một CDN có quy tắc giới hạn tốc độ.

### CDN đặt phía trước

CDN hoặc proxy có bộ nhớ đệm đặt trước reverse proxy của bạn là tùy chọn, và hai ví dụ không cache gì cả. Nếu bạn thêm một cái, ba điều
quyết định một trang đã gỡ hay một ảnh đã xóa có thật sự biến mất hay không:

- **Đừng cache HTML ở rìa (edge).** Trang được gửi với `Cache-Control: s-maxage=300, stale-while-revalidate=3300`, cả trang 404 cũng vậy.
  Cache của Next được xóa khi bạn lưu, xuất bản, gỡ xuất bản hoặc xóa trong trang quản trị, nhưng CDN không hề biết. Một bài bạn gỡ xuất
  bản hoặc xóa vẫn thấy được ở edge tối đa một giờ (năm phút, rồi thời gian stale), và một trang 404 bị cache ngay trước khi bài được xuất
  bản sẽ sai trong chừng đó thời gian. Nếu vẫn cache HTML, hãy purge URL bài viết và các biến thể ngôn ngữ của nó (`/posts/<slug>` và
  `/en/posts/<slug>`) sau mỗi lần gỡ xuất bản hoặc xóa.
- **`/media/*` được cache một năm, có chủ ý.** Địa chỉ ảnh là một UUID không bao giờ đổi nội dung
  (`Cache-Control: public, max-age=31536000, s-maxage=31536000, immutable`). Xóa ảnh gỡ nó khỏi cơ sở dữ liệu ngay, nhưng edge vẫn tiếp tục
  phục vụ: hãy purge `/media/<uuid>.<ext>` và `/_next/image?url=%2Fmedia%2F<uuid>.<ext>...` sau khi xóa, và tạo lại container frontend để
  làm rỗng bản ảnh đã tối ưu ([BACKUP-AND-RESTORE.md](../BACKUP-AND-RESTORE.md#clearing-the-optimized-image-cache), tiếng Anh).
- **Feed và sitemap** được đọc từ backend ở mỗi request và gửi với `max-age=0, must-revalidate`; CDN có thể cache chúng, nhưng chỉ khi nó
  kiểm tra lại.

Địa chỉ client vẫn phải đến từ proxy của chính bạn (`TRUSTED_PROXY_HOPS`, xem ở trên); CDN không thay đổi các giới hạn khác.
[SECURITY.md](../SECURITY.md#caching-and-a-cdn-in-front) (tiếng Anh) có bảng về mỗi phản hồi gửi gì và một trang đã gỡ có thể tồn tại bao lâu.

## TLS với Caddy

[`deploy/Caddyfile.example`](../../deploy/Caddyfile.example) dùng Caddy v2, tự lấy và gia hạn chứng chỉ Let's Encrypt.

```bash
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # thay example.com bằng host của SITE_URL (không có www)
sudo systemctl reload caddy
```

Tệp này chuyển hướng `www.example.com` về `example.com`, proxy tới `127.0.0.1:3000` (đổi nếu bạn đã đổi `SITE_PORT`), áp dụng giới
hạn 1 MB và 6 MB, và không ghi log `/api/auth/github/callback`, `/newsletter/*` và `/api/newsletter/*`. Caddy giữ nguyên header
`Host` và tự đặt `X-Forwarded-For`, đúng điều `TRUSTED_PROXY_HOPS=1` mong đợi. Caddy không ghi access log trừ khi bạn thêm `log`; log lỗi
của nó nêu yêu cầu kèm query khi upstream lỗi, nên `log` toàn cục trong file bỏ query và `Referer` khỏi đó (một `log` bạn thêm vào site
cần cùng `format filter`). Phía sau Cloudflare hãy đặt
`TRUSTED_PROXY_HOPS=2` và cấu hình `trusted_proxies` của Caddy cho các dải địa chỉ của Cloudflare: Caddy giữ nguyên
`X-Forwarded-For` của yêu cầu đến từ các dải đó và thay nó với mọi người gọi khác, nên người gọi thẳng vào origin không được tin.
Vẫn nên để origin chỉ nhận kết nối từ Cloudflare ([Phía sau Cloudflare](#phía-sau-cloudflare)).

## TLS với nginx và certbot

[`deploy/nginx.conf.example`](../../deploy/nginx.conf.example) là bản nginx. Sao chép nó thành `/etc/nginx/conf.d/blog.conf` và thay
`example.com`. Lần đầu, hai khối cổng 443 trỏ tới một chứng chỉ chưa tồn tại, và `nginx -t` từ chối cả tệp: chỉ giữ khối cổng 80,
lấy chứng chỉ, rồi mới thêm hai khối còn lại.

```bash
sudo mkdir -p /var/www/certbot
sudo nginx -t && sudo systemctl reload nginx      # khi tệp mới chỉ có khối cổng 80
sudo certbot certonly --webroot -w /var/www/certbot -d example.com -d www.example.com \
  --deploy-hook 'systemctl reload nginx'
sudo nginx -t && sudo systemctl reload nginx      # sau khi thêm hai khối 443
```

Dùng `certonly` vì certbot không cần sửa tệp nginx nào. Gói certbot tự gia hạn qua đường dẫn `acme-challenge` trong khối cổng 80,
và `--deploy-hook` làm nginx nạp chứng chỉ mới sau mỗi lần gia hạn.

Ba dòng của ví dụ không phải để trang trí:

- `proxy_set_header Host $host`: Next so sánh host của header `Origin` với host của yêu cầu và huỷ mọi Server Action không khớp.
  Thiếu dòng này, nginx gửi `Host: 127.0.0.1:3000` và mọi nút lưu, tải lên, sắp xếp trong trang quản trị đều bị từ chối, và biểu
  mẫu mật khẩu quản trị không đăng nhập được.
- `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`: nối địa chỉ thật của người gọi vào cuối header, đó là mục mà mọi
  giới hạn theo IP đọc (đếm từ bên phải).
- `client_max_body_size 1m` và, trong `location /admin/`, `6m`.

Ví dụ tự nêu **mức sàn TLS** trong cả hai khối cổng 443: `ssl_protocols TLSv1.2 TLSv1.3`, `ssl_prefer_server_ciphers off`,
`ssl_session_tickets off` và `server_tokens off` (header `Server` không nêu phiên bản). `certbot certonly` không bao giờ thêm
`options-ssl-nginx.conf` của certbot, nên thiếu các dòng này thì giao thức, khoá ticket và header phiên bản phụ thuộc vào bản nginx mà
bản phân phối cài. Cố ý không có `ssl_stapling`: Let's Encrypt không còn chạy OCSP. Các dòng nằm trong khối server chứ không ở cấp
`http` vì `nginx.conf` của Debian hoặc Ubuntu đã đặt `ssl_protocols` ở đó, và dòng thứ hai là lỗi "directive is duplicate".

Ví dụ cũng định nghĩa một định dạng log bỏ query string khỏi mọi yêu cầu (từ khoá tìm kiếm và các token dùng một lần không vào log;
log cũng không ghi `Referer`) và tắt log cho callback GitHub. Nó đã được chạy trên một nginx thật
(`DEPLOY_EXAMPLES_DOCKER=1 python scripts/test_deploy_examples.py`). `error.log` của nginx vẫn có thể chép dòng yêu cầu khi upstream
lỗi: hãy giữ log của proxy ngắn hạn (`logrotate` hằng ngày, `rotate 7`).

## Tuỳ chọn: đăng nhập GitHub cho độc giả

Mặc định tắt. Khi không có nó, site vẫn dùng đầy đủ cho khách, nhưng không ai bình luận, thích hay lưu bài được, và mọi lời mời đăng
nhập dẫn tới một trang báo rằng đăng nhập chưa được bật. Để bật, tạo một GitHub OAuth App có callback đúng là
`<SITE_URL>/api/auth/github/callback`, đặt `GITHUB_CLIENT_ID` và `GITHUB_CLIENT_SECRET` vào `.env` rồi chạy `docker compose up -d`.
Quy trình đầy đủ, các yêu cầu (HTTPS, một host duy nhất) và `ADMIN_GITHUB_ID` nằm trong
[CONFIGURATION.md](../CONFIGURATION.md#github-login-in-production). Quản trị viên luôn đăng nhập bằng mật khẩu đặt ở `/setup`
tại `/admin/login`, dù có GitHub hay không.

## Tuỳ chọn: gửi email newsletter

Độc giả có thể đăng ký ở `/newsletter` ngay từ phút đầu, nhưng với `NEWSLETTER_TRANSPORT=log` mặc định thì không có email nào rời
khỏi máy. Để gửi email thật bạn cần một nhà cung cấp SMTP (cổng 587, STARTTLS; hoặc cổng 465 với `SMTP_PROTOCOL=smtps`), một tên miền gửi thư đã xác thực (SPF, DKIM) và năm
biến trong `.env`: `NEWSLETTER_TRANSPORT=smtp`, `NEWSLETTER_FROM`, `NEWSLETTER_SECRET` (đã ngẫu nhiên sau `init-env`; không bao
giờ đổi sau khi có người đăng ký đầu tiên), `SMTP_HOST` và thông tin đăng nhập. Backend từ chối khởi động nếu cấu hình chưa đủ. Xem
[CONFIGURATION.md](../CONFIGURATION.md#newsletter-in-production).

## Tuỳ chọn: tìm kiếm bằng Meilisearch

Tìm kiếm toàn văn của PostgreSQL chạy sẵn. Meilisearch thêm khả năng tìm theo một phần từ, chịu lỗi gõ và trích đoạn, và là
service compose thứ tư chỉ khởi động với profile `search`:

```bash
docker compose --profile search up -d --build
```

Bật công cụ này là một quy trình thủ công theo thứ tự (lập chỉ mục trước, rồi reindex, rồi chuyển công cụ), và việc quay lui chỉ
là một biến. Quy trình được mô tả ở [CONFIGURATION.md](../CONFIGURATION.md#search-with-meilisearch). Chỉ mục là một bản sao và
không cần sao lưu.

## Sau khi cài đặt

- Nhận quyền sở hữu site, bật xác minh hai bước và nạp nội dung: [FIRST-RUN.md](FIRST-RUN.md).
- Biết bạn đặt được những gì: [CONFIGURATION.md](../CONFIGURATION.md) và [ADMIN-GUIDE.md](ADMIN-GUIDE.md).
- Khoảng hai tuần sau khi site công khai và HTTPS đã ổn định: nâng HSTS lên một năm ([Nâng HSTS](#nâng-hsts-khi-https-đã-ổn-định)).
- Sao lưu **trước khi cần đến**: [BACKUP-AND-RESTORE.md](../BACKUP-AND-RESTORE.md). Ảnh tải lên nằm trong PostgreSQL, nên một
  lệnh `pg_dump` bao gồm cả bài viết lẫn ảnh.
- Cập nhật lên phiên bản mới: [UPGRADING.md](../UPGRADING.md).
- Có gì đó không khởi động: [TROUBLESHOOTING.md](../TROUBLESHOOTING.md).
