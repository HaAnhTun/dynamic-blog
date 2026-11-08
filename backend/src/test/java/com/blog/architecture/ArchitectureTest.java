package com.blog.architecture;

import static com.tngtech.archunit.base.DescribedPredicate.not;
import static com.tngtech.archunit.core.domain.JavaCall.Predicates.target;
import static com.tngtech.archunit.core.domain.JavaClass.Predicates.assignableTo;
import static com.tngtech.archunit.core.domain.JavaClass.Predicates.belongToAnyOf;
import static com.tngtech.archunit.core.domain.JavaClass.Predicates.resideInAPackage;
import static com.tngtech.archunit.core.domain.JavaClass.Predicates.simpleNameStartingWith;
import static com.tngtech.archunit.core.domain.properties.HasName.Predicates.name;
import static com.tngtech.archunit.core.domain.properties.HasOwner.Predicates.With.owner;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.library.freeze.FreezingArchRule.freeze;

import com.blog.auth.service.AuthService;
import com.blog.auth.service.RefreshTokenService;
import com.blog.auth.service.TokenService;
import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import com.tngtech.archunit.library.GeneralCodingRules;

/**
 * Layering and coding rules for production code. Existing violations are frozen in
 * {@code src/test/resources/archunit_store}: they may only shrink, a new violation fails the build.
 */
@AnalyzeClasses(packages = "com.blog", importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    @ArchTest
    static final ArchRule CONTROLLERS_DO_NOT_USE_REPOSITORIES = freeze(noClasses()
            .that()
            .resideInAPackage("..controller..")
            .should()
            .dependOnClassesThat()
            .resideInAPackage("..repository.."));

    @ArchTest
    static final ArchRule CONTROLLERS_DO_NOT_EXPOSE_ENTITIES = freeze(noClasses()
            .that()
            .resideInAPackage("..controller..")
            .should()
            .dependOnClassesThat()
            .resideInAPackage("..entity.."));

    @ArchTest
    static final ArchRule SERVICES_DO_NOT_DEPEND_ON_CONTROLLERS = freeze(noClasses()
            .that()
            .resideInAPackage("..service..")
            .should()
            .dependOnClassesThat()
            .resideInAPackage("..controller.."));

    @ArchTest
    static final ArchRule REPOSITORIES_ARE_USED_ONLY_BY_SERVICES_AND_DATA_LAYERS = freeze(classes()
            .that()
            .resideInAPackage("..repository..")
            .should()
            .onlyHaveDependentClassesThat(resideInAPackage("..service..")
                    .or(resideInAPackage("..repository.."))
                    .or(resideInAPackage("..mapper.."))
                    .or(resideInAPackage("..specification.."))));

    @ArchTest
    static final ArchRule DTOS_ARE_NOT_ENTITIES = freeze(
            noClasses().that().resideInAPackage("..dto..").should().beAnnotatedWith("jakarta.persistence.Entity"));

    @ArchTest
    static final ArchRule ENTITIES_LIVE_IN_ENTITY_PACKAGES = freeze(classes()
            .that()
            .areAnnotatedWith("jakarta.persistence.Entity")
            .should()
            .resideInAPackage("..entity.."));

    @ArchTest
    static final ArchRule CONTROLLERS_ARE_NOT_REFERENCED_OUTSIDE_CONTROLLER_PACKAGES = freeze(noClasses()
            .that()
            .resideOutsideOfPackage("..controller..")
            .should()
            .dependOnClassesThat()
            .resideInAPackage("..controller.."));

    // Sessions are minted through one funnel, so no path to a session can skip the second step (docs/CONVENTIONS.md,
    // section 10). These are plain rules, not frozen ones: there is no existing violation. A new caller has to extend
    // the
    // list below in the same commit, which is the point. The services themselves (RefreshTokenService rotating a token,
    // TokenService's overloads) may call their own methods. Test code is not analysed (DoNotIncludeTests) and uses the
    // AuthTestSupport helpers.

    /** The classes that may call {@code AuthService.issueSession}: the gate itself and the services that verify a second factor or change a password. */
    private static final DescribedPredicate<JavaClass> MAY_START_A_SESSION = belongToAnyOf(AuthService.class)
            .or(simpleNameStartingWith("MfaService"))
            .or(simpleNameStartingWith("PasswordChangeService"));

    @ArchTest
    static final ArchRule REFRESH_TOKEN_ROWS_ARE_OPENED_ONLY_BY_THE_AUTH_SERVICE = noClasses()
            .that(not(belongToAnyOf(AuthService.class, RefreshTokenService.class)))
            .should()
            .callMethodWhere(target(owner(assignableTo(RefreshTokenService.class)))
                    .and(target(name("open")).or(target(name("issue")))));

    @ArchTest
    static final ArchRule ACCESS_TOKENS_ARE_MINTED_ONLY_BY_THE_AUTH_SERVICE = noClasses()
            .that(not(belongToAnyOf(AuthService.class, TokenService.class)))
            .should()
            .callMethodWhere(target(owner(assignableTo(TokenService.class))).and(target(name("mint"))));

    @ArchTest
    static final ArchRule SESSIONS_ARE_ISSUED_ONLY_BY_THE_LISTED_SERVICES = noClasses()
            .that(not(MAY_START_A_SESSION))
            .should()
            .callMethodWhere(target(owner(assignableTo(AuthService.class))).and(target(name("issueSession"))));

    /** A record prints every component in its generated toString: one that holds a secret writes its own ({@link SecretRecordRules}). */
    @ArchTest
    static final ArchRule RECORDS_WITH_A_SECRET_COMPONENT_REDACT_IT_IN_TO_STRING =
            SecretRecordRules.RECORDS_WITH_A_SECRET_COMPONENT_REDACT_IT_IN_TO_STRING;

    @ArchTest
    static final ArchRule NO_FIELD_INJECTION = freeze(GeneralCodingRules.NO_CLASSES_SHOULD_USE_FIELD_INJECTION);

    @ArchTest
    static final ArchRule NO_STANDARD_STREAMS = freeze(GeneralCodingRules.NO_CLASSES_SHOULD_ACCESS_STANDARD_STREAMS);

    @ArchTest
    static final ArchRule NO_JAVA_UTIL_LOGGING = freeze(GeneralCodingRules.NO_CLASSES_SHOULD_USE_JAVA_UTIL_LOGGING);
}
