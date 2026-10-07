exports.up = function (knex) {
    return knex.schema.alterTable("heartbeat", function (table) {
        table.text("traceroute").nullable();
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("heartbeat", function (table) {
        table.dropColumn("traceroute");
    });
};
