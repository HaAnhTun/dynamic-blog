package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.auth.service.TokenService;
import com.blog.common.config.SecurityProperties;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.repository.UserRepository;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;

/**
 * A reviewer's throwaway probe during Task 5, now committed alongside Task 6's chain
 * rewrite because it is the net that rewrite needs.
 *
 * Two separate concerns:
 *
 * 1. /auth/me must answer 401 for every way a bearer token can be wrong (missing,
 *    tampered, foreign-signed, expired), paired with the 200 control for a valid one —
 *    so that the 401s are known to be about the tokens and not a broken route.
 *
 * 2. The @Order(1) token-endpoints chain's securityMatcher is exact-path. If a future
 *    change made it prefix-based (e.g. "/api/v1/auth/logout/**"), bearer authentication
 *    would silently stop running on that path for the main chain, defeating the whole
 *    reason that chain exists (see SecurityConfig's authTokenEndpointsChain javadoc). An
 *    expired-but-correctly-signed token attached to a near-miss path is the probe: if the
 *    matcher is still exact, the main chain's resource server filter sees the token,
 *    rejects it as expired, and answers 401 before authorizeHttpRequests is even
 *    consulted — exactly like /auth/me.
 */
@AutoConfigureMockMvc
class SecurityBoundaryIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private SecurityProperties securityProperties;

    @Autowired
    private ObjectMapper objectMapper;

    private String validAdminToken() {
        return auth.bearerForAdmin();
    }

    private String tamperedSignatureToken() {
        String token = validAdminToken().substring("Bearer ".length());
        int lastDot = token.lastIndexOf('.');
        String signature = token.substring(lastDot + 1);
        // Flip one character in the signature segment so the token still has the shape
        // header.payload.signature but verifies against nothing.
        char flipped = signature.charAt(0) == 'A' ? 'B' : 'A';
        String tamperedSignature = flipped + signature.substring(1);
        return token.substring(0, lastDot + 1) + tamperedSignature;
    }

    private String foreignSignedToken() {
        // A real token, through a real encoder, just not the one this application trusts —
        // a garbage string would be rejected for a different reason (malformed, not
        // "wrong signer") and would prove nothing about signature verification.
        var foreignKey = new SecretKeySpec(
                "a-completely-different-secret-at-least-32-bytes".getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        JwtEncoder foreignEncoder = NimbusJwtEncoder.withSecretKey(foreignKey).build();
        Instant now = Instant.now();
        var admin = userRepository.findByEmail("admin@blog.local").orElseThrow();
        return foreignEncoder
                .encode(JwtEncoderParameters.from(
                        JwsHeader.with(() -> "HS256").build(),
                        JwtClaimsSet.builder()
                                .subject(admin.getId().toString())
                                .issuedAt(now)
                                .expiresAt(now.plusSeconds(900))
                                .claim("role", "ADMIN")
                                .build()))
                .getTokenValue();
    }

    private String expiredButCorrectlySignedToken() {
        // Signed with the real key, so the filter chain's only objection can be the
        // expiry — not a signature problem it could reject for a different reason.
        //
        // Goes through the shared helper rather than building the claim set here: this is a
        // well-formed token, so TokenService.mint is the only thing that should decide its
        // shape. The hand-built copy this replaced would have kept passing, against a token
        // the server never issues, on the day a claim was added to mint.
        return auth.expiredBearerForAdmin().substring("Bearer ".length());
    }

    @Test
    void meAcceptsAGenuinelyValidToken() throws Exception {
        // The control: proves the four 401s below are about the tokens, not the route.
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", validAdminToken()))
                .andExpect(status().isOk());
    }

    @Test
    void meRejectsNoToken() throws Exception {
        mockMvc.perform(get("/api/v1/auth/me")).andExpect(status().isUnauthorized());
    }

    @Test
    void meRejectsATamperedSignature() throws Exception {
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + tamperedSignatureToken()))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void meRejectsAForeignSignedToken() throws Exception {
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + foreignSignedToken()))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void meRejectsAnExpiredToken() throws Exception {
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + expiredButCorrectlySignedToken()))
                .andExpect(status().isUnauthorized());
    }

    // --- What a token must be besides well signed (audit 075)
    // ---------------------------------------------------------
    //
    // Each of these tokens is the claim set of a REAL session token of the administrator with ONE thing changed, put
    // together by
    // hand and signed (when it is signed at all) with the real secret, so the only reason for the 401 is that one
    // thing. The
    // control signs the unchanged claims the same way and gets 200: the helper makes tokens the server would accept.

    private Map<String, Object> claimsOfARealToken() throws Exception {
        var admin = userRepository.findByEmail("admin@blog.local").orElseThrow();
        String token = auth.verifiedSession(admin).accessToken();
        byte[] payload = Base64.getUrlDecoder().decode(token.split("\\.")[1]);
        @SuppressWarnings("unchecked")
        Map<String, Object> claims = objectMapper.readValue(payload, LinkedHashMap.class);
        return claims;
    }

    private String b64(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /** A compact JWS made by hand: the header, the claims, and an HMAC of the given algorithm with the real secret (or none). */
    private String compact(String headerAlg, String hmac, Map<String, Object> claims) throws Exception {
        String signingInput = b64(("{\"alg\":\"" + headerAlg + "\"}").getBytes(StandardCharsets.UTF_8))
                + "."
                + b64(objectMapper.writeValueAsBytes(claims));
        if (hmac == null) {
            return signingInput + ".";
        }
        Mac mac = Mac.getInstance(hmac);
        mac.init(new SecretKeySpec(securityProperties.jwtSecret().getBytes(StandardCharsets.UTF_8), hmac));
        return signingInput + "." + b64(mac.doFinal(signingInput.getBytes(StandardCharsets.UTF_8)));
    }

    private int meStatusOf(String token) throws Exception {
        return mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + token))
                .andReturn()
                .getResponse()
                .getStatus();
    }

    @Test
    void aHandMadeTokenWithTheRealClaimsAndTheRealKeyIsAccepted_theControlOfTheCasesBelow() throws Exception {
        assertThat(meStatusOf(compact("HS256", "HmacSHA256", claimsOfARealToken())))
                .isEqualTo(200);
    }

    @Test
    void aTokenWithAlgNoneAndNoSignatureIsRefused() throws Exception {
        assertThat(meStatusOf(compact("none", null, claimsOfARealToken()))).isEqualTo(401);
    }

    @Test
    void aTokenSignedWithHS512UsingTheRealSecretIsRefused() throws Exception {
        // Only HS256 is accepted, whatever the key: an algorithm the server did not choose is not a way in.
        assertThat(meStatusOf(compact("HS512", "HmacSHA512", claimsOfARealToken())))
                .isEqualTo(401);
    }

    static List<Object[]> claimsThatMakeATokenWrong() {
        Consumer<Map<String, Object>> noExp = claims -> claims.remove("exp");
        Consumer<Map<String, Object>> noIat = claims -> claims.remove("iat");
        Consumer<Map<String, Object>> noSub = claims -> claims.remove("sub");
        Consumer<Map<String, Object>> noIss = claims -> claims.remove("iss");
        Consumer<Map<String, Object>> wrongIss = claims -> claims.put("iss", "someone-else");
        Consumer<Map<String, Object>> noAud = claims -> claims.remove("aud");
        Consumer<Map<String, Object>> wrongAud = claims -> claims.put("aud", List.of("another-api"));
        Consumer<Map<String, Object>> extraAud = claims -> claims.put("aud", List.of("another-api", "not-this-one"));
        return List.of(
                new Object[] {"no exp", noExp},
                new Object[] {"no iat", noIat},
                new Object[] {"no sub", noSub},
                new Object[] {"no iss", noIss},
                new Object[] {"another iss", wrongIss},
                new Object[] {"no aud", noAud},
                new Object[] {"another aud", wrongAud},
                new Object[] {"several auds, none of them this API", extraAud});
    }

    @ParameterizedTest(name = "a correctly signed token with {0} is refused")
    @MethodSource("claimsThatMakeATokenWrong")
    void aCorrectlySignedTokenWithAWrongClaimIsRefused(String what, Consumer<Map<String, Object>> damage)
            throws Exception {
        Map<String, Object> claims = claimsOfARealToken();
        assertThat(claims)
                .as("the real token carries what these cases take away")
                .containsKeys("exp", "iat", "sub", "iss", "aud");
        assertThat(claims.get("iss")).isEqualTo(TokenService.ISSUER);
        damage.accept(claims);

        assertThat(meStatusOf(compact("HS256", "HmacSHA256", claims))).as(what).isEqualTo(401);
    }

    @Test
    void aTokenOfTheRightIssuerAndAudienceButExpiredIsStillRefused() throws Exception {
        Map<String, Object> claims = claimsOfARealToken();
        claims.put("exp", Instant.now().minusSeconds(600).getEpochSecond());

        assertThat(meStatusOf(compact("HS256", "HmacSHA256", claims))).isEqualTo(401);
    }

    @Test
    void aTrailingSlashOnLogoutIsNotMatchedByTheTokenEndpointsChain() throws Exception {
        // If the securityMatcher were prefix-based, this near-miss path would land in
        // authTokenEndpointsChain, which has no oauth2ResourceServer at all, and the
        // expired token below would go completely unexamined. Because the matcher is
        // exact, this path instead falls to the main chain, whose resource-server filter
        // authenticates (and rejects) the bearer token before authorizeHttpRequests runs —
        // the same mechanism that makes /auth/me's 401 trustworthy above.
        mockMvc.perform(post("/api/v1/auth/logout/")
                        .header("Authorization", "Bearer " + expiredButCorrectlySignedToken()))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void anExtraPathSegmentOnLoginIsNotMatchedByTheTokenEndpointsChain() throws Exception {
        mockMvc.perform(post("/api/v1/auth/login/extra")
                        .header("Authorization", "Bearer " + expiredButCorrectlySignedToken()))
                .andExpect(status().isUnauthorized());
    }
}
