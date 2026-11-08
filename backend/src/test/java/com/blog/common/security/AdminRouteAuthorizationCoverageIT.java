package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.http.HttpMethod;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

/**
 * Every handler under {@code /api/v1/admin} has an authorization decision, and a new one cannot slip in without one.
 *
 * <p>The URL rule of SecurityConfig is ADMIN only for the whole tree, with a short list of trees an AUTHOR may enter
 * (posts, post-import, tags, categories, analytics). This test walks the real handler mapping:
 * <ul>
 *   <li>a handler outside the AUTHOR trees is refused to an AUTHOR, a reader and an anonymous caller by the filter chain
 *       itself (403, 403, 401): one call each, which never reaches the handler;</li>
 *   <li>a handler inside an AUTHOR tree is either ADMIN only by {@code @PreAuthorize("hasRole('ADMIN')")}, or owner or
 *       ADMIN by a rule that names {@code isOwner}, or on the reviewed {@link #AUTHOR_CAPABLE} list, whose scope is
 *       decided in the service. Anything else fails: add the decision (and a row in SecurityMatrixIT) with the handler;</li>
 *   <li>an unmapped path under the tree is a 403 for an AUTHOR (only an ADMIN gets the 404): the default is closed.</li>
 * </ul>
 */
@AutoConfigureMockMvc
class AdminRouteAuthorizationCoverageIT extends AbstractIntegrationTest {

    private static final String ADMIN = "/api/v1/admin";

    /** The trees SecurityConfig opens to an AUTHOR; keep in step with the list there. */
    private static final List<String> AUTHOR_TREES = List.of(
            ADMIN + "/posts", ADMIN + "/post-import", ADMIN + "/tags", ADMIN + "/categories", ADMIN + "/analytics");

    /** How the scope of an AUTHOR is decided for a handler that carries no {@code @PreAuthorize}. */
    private enum Scope {
        /** The service reads the caller from the token and touches only the caller's own posts. */
        OWN_POSTS_IN_SERVICE,
        /** Categories and tags are one pool shared by all authors (docs/SECURITY.md): list and create only. */
        SHARED_POOL
    }

    /** Reviewed: an AUTHOR may call these. Adding a handler to an AUTHOR tree means adding it here on purpose. */
    private static final Map<String, Scope> AUTHOR_CAPABLE = Map.ofEntries(
            Map.entry("GET " + ADMIN + "/posts", Scope.OWN_POSTS_IN_SERVICE),
            Map.entry("POST " + ADMIN + "/posts", Scope.OWN_POSTS_IN_SERVICE),
            Map.entry("GET " + ADMIN + "/analytics", Scope.OWN_POSTS_IN_SERVICE),
            Map.entry("GET " + ADMIN + "/post-import/template", Scope.OWN_POSTS_IN_SERVICE),
            Map.entry("GET " + ADMIN + "/post-import/status", Scope.OWN_POSTS_IN_SERVICE),
            Map.entry("POST " + ADMIN + "/post-import/preview", Scope.OWN_POSTS_IN_SERVICE),
            Map.entry("POST " + ADMIN + "/post-import/article-preview", Scope.OWN_POSTS_IN_SERVICE),
            Map.entry("POST " + ADMIN + "/post-import/apply", Scope.OWN_POSTS_IN_SERVICE),
            Map.entry("GET " + ADMIN + "/tags", Scope.SHARED_POOL),
            Map.entry("POST " + ADMIN + "/tags", Scope.SHARED_POOL),
            Map.entry("GET " + ADMIN + "/categories", Scope.SHARED_POOL),
            Map.entry("POST " + ADMIN + "/categories", Scope.SHARED_POOL));

    @Autowired
    @Qualifier("requestMappingHandlerMapping")
    private RequestMappingHandlerMapping handlerMapping;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    /** One admin route: the method, the pattern and the handler behind it. */
    private record Route(HttpMethod method, String pattern, HandlerMethod handler) {

        String key() {
            return method + " " + pattern;
        }

        boolean inAuthorTree() {
            return AUTHOR_TREES.stream().anyMatch(tree -> pattern.equals(tree) || pattern.startsWith(tree + "/"));
        }

        /** The path with every variable replaced by a random id; the filter chain refuses before it is parsed. */
        String samplePath() {
            return pattern.replaceAll("\\{[^}]+}", UUID.randomUUID().toString());
        }

        /** The {@code @PreAuthorize} on the method, else on the class; null when there is none. */
        String preAuthorize() {
            PreAuthorize annotation =
                    AnnotatedElementUtils.findMergedAnnotation(handler.getMethod(), PreAuthorize.class);
            if (annotation == null) {
                annotation = AnnotatedElementUtils.findMergedAnnotation(handler.getBeanType(), PreAuthorize.class);
            }
            return annotation == null ? null : annotation.value();
        }
    }

    private List<Route> adminRoutes() {
        List<Route> routes = new ArrayList<>();
        for (Map.Entry<RequestMappingInfo, HandlerMethod> entry :
                handlerMapping.getHandlerMethods().entrySet()) {
            RequestMappingInfo info = entry.getKey();
            Set<String> patterns = info.getPathPatternsCondition() == null
                    ? Set.of()
                    : info.getPathPatternsCondition().getPatternValues();
            Set<org.springframework.web.bind.annotation.RequestMethod> methods =
                    info.getMethodsCondition().getMethods();
            for (String pattern : patterns) {
                if (!pattern.startsWith(ADMIN + "/") && !pattern.equals(ADMIN)) {
                    continue;
                }
                if (methods.isEmpty()) {
                    routes.add(new Route(HttpMethod.GET, pattern, entry.getValue()));
                }
                methods.forEach(
                        method -> routes.add(new Route(HttpMethod.valueOf(method.name()), pattern, entry.getValue())));
            }
        }
        return routes;
    }

    @Test
    void the_walk_sees_the_admin_routes() {
        Map<String, Route> routes = new TreeMap<>();
        adminRoutes().forEach(route -> routes.put(route.key(), route));

        // A guard against a walk that finds nothing (a renamed bean, a changed base path) and so checks nothing.
        assertThat(routes).hasSizeGreaterThan(40);
        assertThat(routes).containsKeys("GET " + ADMIN + "/posts", "GET " + ADMIN + "/users");
    }

    @Test
    void a_route_outside_the_author_trees_is_refused_by_the_filter_chain_to_an_author_a_reader_and_nobody()
            throws Exception {
        String author = auth.bearerFor(auth.createAuthor("coverage-author-" + UUID.randomUUID() + "@blog.local"));
        String reader = auth.bearerFor(auth.createReader(auth.nextGithubId(), "coverage-" + UUID.randomUUID()));
        List<String> failures = new ArrayList<>();
        int checked = 0;
        for (Route route : adminRoutes()) {
            if (route.inAuthorTree()) {
                continue;
            }
            checked++;
            record(failures, route, "author", 403, call(route, author));
            record(failures, route, "reader", 403, call(route, reader));
            record(failures, route, "anonymous", 401, call(route, null));
        }

        assertThat(checked).as("routes outside the author trees").isGreaterThan(20);
        assertThat(failures).isEmpty();
    }

    @Test
    void a_route_inside_an_author_tree_has_a_reviewed_decision() {
        List<String> undecided = new ArrayList<>();
        Set<String> seen = new java.util.HashSet<>();
        for (Route route : adminRoutes()) {
            if (!route.inAuthorTree()) {
                continue;
            }
            seen.add(route.key());
            String rule = route.preAuthorize();
            boolean listed = AUTHOR_CAPABLE.containsKey(route.key());
            if (rule == null) {
                if (!listed) {
                    undecided.add(route.key() + " has no @PreAuthorize and is not in AUTHOR_CAPABLE");
                }
            } else if (rule.equals("hasRole('ADMIN')")) {
                if (listed) {
                    undecided.add(route.key() + " is ADMIN only by @PreAuthorize but listed as AUTHOR-capable");
                }
            } else if (rule.contains("isOwner")) {
                if (listed) {
                    undecided.add(route.key() + " is decided by ownership and must not also be in AUTHOR_CAPABLE");
                }
            } else {
                undecided.add(route.key() + " has a rule nobody reviewed here: " + rule);
            }
        }
        // A list entry whose handler is gone is a stale decision, which hides the next change.
        AUTHOR_CAPABLE.keySet().stream()
                .filter(key -> !seen.contains(key))
                .forEach(key -> undecided.add(key + " is in AUTHOR_CAPABLE but there is no such handler"));

        assertThat(undecided).isEmpty();
    }

    @Test
    void an_unmapped_admin_path_is_closed_to_an_author_and_only_an_admin_reaches_the_404() throws Exception {
        String author = auth.bearerFor(auth.createAuthor("coverage-default-" + UUID.randomUUID() + "@blog.local"));

        mockMvc.perform(request(HttpMethod.GET, ADMIN + "/a-tree-nobody-decided")
                        .header("Authorization", author))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));
        mockMvc.perform(request(HttpMethod.POST, ADMIN + "/a-tree-nobody-decided/x")
                        .header("Authorization", author))
                .andExpect(status().isForbidden());
        mockMvc.perform(request(HttpMethod.GET, ADMIN + "/a-tree-nobody-decided")
                        .header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("ENDPOINT_NOT_FOUND"));
    }

    private int call(Route route, String bearer) throws Exception {
        var builder = request(route.method(), route.samplePath());
        if (bearer != null) {
            builder.header("Authorization", bearer);
        }
        return mockMvc.perform(builder).andReturn().getResponse().getStatus();
    }

    private static void record(List<String> failures, Route route, String caller, int expected, int actual) {
        if (actual != expected) {
            failures.add(route.key() + " as " + caller + ": expected " + expected + " but got " + actual);
        }
    }
}
