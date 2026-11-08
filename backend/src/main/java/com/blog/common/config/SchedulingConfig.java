package com.blog.common.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Enables {@code @Scheduled} for the whole application: RefreshTokenCleanup, the newsletter worker, the search outbox
 * worker. Spring Boot creates the TaskScheduler itself, with two threads per {@code spring.task.scheduling.pool.size}
 * (application.yml). Each job has its own schedule in the configuration, and its flag or cron {@code -} turns off that
 * job alone.
 */
@Configuration
@EnableScheduling
public class SchedulingConfig {}
