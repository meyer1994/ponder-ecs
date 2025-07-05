/**
 * ECS Fargate Infrastructure
 *
 * This CDK stack creates:
 * - ECS Fargate cluster with PostgreSQL and application services
 */

import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as svcdisc from "aws-cdk-lib/aws-servicediscovery";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { Construct } from "constructs";

export class EcsInfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create VPC
    const vpc = new ec2.Vpc(this, `${id}-vpc`, {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // Create ECS Cluster
    const cluster = new ecs.Cluster(this, `${id}-cluster`, {
      vpc,
      clusterName: `${id}-cluster`,
    });

    // Create ECR repository for the application
    const repository = new ecr.Repository(this, `${id}-repo`, {
      repositoryName: id,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteImages: true,
    });

    // Create CloudMap Namespace
    const namespace = new svcdisc.PrivateDnsNamespace(this, `${id}-namespace`, {
      name: `${id}.local`,
      vpc,
    });

    // PostgreSQL Task Definition
    const pgTask = new ecs.FargateTaskDefinition(this, `${id}-pg-task`, {
      memoryLimitMiB: 1024,
      cpu: 512,
    });

    // PostgreSQL Container
    const pgContainer = pgTask.addContainer(`${id}-pg-container`, {
      image: ecs.ContainerImage.fromRegistry("postgres:15-alpine"),
      portMappings: [{ containerPort: 5432 }],
      environment: {
        POSTGRES_USER: "postgres",
        POSTGRES_PASSWORD: "postgres",
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "postgres",
        logGroup: new logs.LogGroup(this, `${id}-postgres-log-group`, {
          logGroupName: `/ecs/${id}-postgres`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    // PostgreSQL Service
    const pgService = new ecs.FargateService(this, `${id}-postgres-service`, {
      cluster,
      taskDefinition: pgTask,
      desiredCount: 1,
      serviceName: "postgres",
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      assignPublicIp: false,
      cloudMapOptions: {
        name: "postgres", // this defines the DNS name of the service. eg postgres.ponder.local
        cloudMapNamespace: namespace,
        dnsRecordType: svcdisc.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(60),
        containerPort: 5432,
        container: pgContainer,
      },
    });

    // Application Task Definition
    const ponderTask = new ecs.FargateTaskDefinition(this, `${id}-app-task`, {
      memoryLimitMiB: 1024,
      cpu: 512,
    });

    const ponderContainer = ponderTask.addContainer(`${id}-app-container`, {
      image: ecs.ContainerImage.fromEcrRepository(repository),
      portMappings: [{ containerPort: 42069 }],
      environment: {
        NODE_ENV: "production",
        PONDER_LOG_LEVEL: "trace",
        DATABASE_SCHEMA: "test",
        DATABASE_URL: `postgres://postgres:postgres@postgres.${id}.local:5432/postgres`,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "app",
        logGroup: new logs.LogGroup(this, `${id}-app-log-group`, {
          logGroupName: `/ecs/${id}-app`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    // Application Service
    const ponderService = new ecs.FargateService(this, `${id}-app-service`, {
      cluster,
      taskDefinition: ponderTask,
      desiredCount: 1,
      serviceName: "ponder",
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      cloudMapOptions: {
        name: "ponder",
        cloudMapNamespace: namespace,
        dnsRecordType: svcdisc.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(60),
        containerPort: 42069,
        container: ponderContainer,
      },
    });

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, `${id}-alb`, {
      vpc,
      internetFacing: true,
      loadBalancerName: `${id}-alb`,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener(`${id}-alb-listener`, {
      port: 80,
      open: true,
    });

    listener.addTargets(`${id}-alb-listener-target`, {
      port: 42069,
      targets: [ponderService],
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(60),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    ponderService.connections.allowFrom(alb, ec2.Port.tcp(42069));
    pgService.connections.allowFrom(ponderService, ec2.Port.tcp(5432));

    // Outputs
    new cdk.CfnOutput(this, `${id}-app-alb-url`, {
      value: `http://${alb.loadBalancerDnsName}`,
      description: "URL of the Application Load Balancer",
    });

    new cdk.CfnOutput(this, `${id}-app-ecr-uri`, {
      value: repository.repositoryUri,
      description: "Application ECR repository URI",
    });

    new cdk.CfnOutput(this, `${id}-namespace-name`, {
      value: namespace.namespaceName,
      description: "CloudMap Namespace Name",
    });

    new cdk.CfnOutput(this, `${id}-vpc-id`, {
      value: vpc.vpcId,
      description: "VPC ID",
    });

    new cdk.CfnOutput(this, `${id}-cluster-name`, {
      value: cluster.clusterName,
      description: "ECS Cluster Name",
    });

    vpc.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    namespace.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    repository.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    pgTask.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    pgService.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    ponderTask.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    ponderService.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    alb.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    listener.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}

// App instantiation
const app = new cdk.App();
new EcsInfrastructureStack(app, "ponder", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
